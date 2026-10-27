import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { classifyPairedRoute } from '../../../../config/vite/pairedRoutePolicy.ts';
import { readStoredZip, writeStoredZip } from './timeline-transfer-zip.ts';
import { exportTimelineArchive, importTimelineArchive, uniqueTimelineName } from './timeline-transfer.ts';

const download = vi.hoisted(() => vi.fn());
vi.mock('@/shared/runtime/browserDownloadRuntime.ts', () => ({ downloadBlobAsFile: download }));
beforeEach(() => download.mockClear());

const mediaSha = 'b'.repeat(64);
const artifactDigest = 'sha256:' + 'a'.repeat(64);

function preparedJson(media = true) {
  return { timeline_id: 'prepared-id', publication: { dependency_manifest: { media: media ? [{ media_id: `sha256:${mediaSha}` }] : [] }, shot_revisions: [] }, transcripts: [], text_bindings: [] };
}

async function archiveBlob(media = true, extraEntries: Array<{ name: string; value: string }> = [], mediaType = 'video/mp4', transcript?: { name: string; value: string }): Promise<Blob> {
  const mediaBytes = new TextEncoder().encode('tiny media payload');
  const manifest = {
    format: 'astrid.timeline/1', name: 'Imported Cut', elements: [],
    media: media ? [{ sha256: mediaSha, size: mediaBytes.byteLength, media_type: mediaType, original_name: 'clip.mp4' }] : [],
    transcripts: transcript ? [transcript.name] : [],
  };
  const values = [
    { name: 'manifest.json', value: JSON.stringify(manifest) },
    { name: 'timeline.json', value: JSON.stringify({ project_id: 'source-project', timeline_id: 'source-timeline' }) },
    ...(media ? [{ name: `media/${mediaSha}`, value: 'tiny media payload' }] : []),
    ...(transcript ? [transcript] : []),
    ...extraEntries,
  ];
  const chunks: Uint8Array[] = [];
  await writeStoredZip(values.map(({ name, value }) => {
    const bytes = new TextEncoder().encode(value);
    return { name, size: bytes.length, stream: () => new ReadableStream({ start(c) { c.enqueue(bytes); c.close(); } }) };
  }), new WritableStream({ write(chunk) { chunks.push(chunk.slice()); } }));
  return new Blob(chunks);
}

function fakeClient(options: { checkFails?: boolean; existingMedia?: boolean; missing?: string[]; different?: string[] } = {}) {
  const admissions: Array<Record<string, unknown>> = [];
  const admissionKeys: string[] = [];
  const uploads: Array<{ digest: string; blob: Blob; url: string; mediaType: string; expectedDigest: string; idempotencyKey: string }> = [];
  const commits: unknown[] = [];
  const commitKeys: string[] = [];
  const client = {
    listCapabilities: vi.fn(async () => ({ items: [{ capability_id: 'rendering.timeline_prepare_import', definition_digest: 'sha256:capability', status: 'ready', estimated_scratch_bytes: 10, estimated_output_bytes: 20 }], next_cursor: null })),
    admitTask: vi.fn(async (input: Record<string, unknown>, idempotencyKey: string) => {
      admissions.push(input);
      admissionKeys.push(idempotencyKey);
      const params = ((input.spec as { inputs: Record<string, unknown> }).inputs);
      const fail = params.check_only === true && options.checkFails;
      const taskId = params.check_only === true ? 'check-task' : 'prepare-task';
      return { task_id: taskId, state: fail ? 'failed' : 'succeeded', result: fail ? { error: { message: 'stale pin: am-callout' } } : null };
    }),
    getTask: vi.fn(async () => { throw new Error('completed tasks must not be polled'); }),
    listManagedOutputs: vi.fn(async (taskId: string) => {
      if (taskId === 'check-task' && options.checkFails) return { items: [], next_cursor: null };
      const port = taskId === 'check-task' ? 'result' : 'prepared';
      return { items: [{ output_port: port, digest: artifactDigest }], next_cursor: null };
    }),
    ingestProjectObject: vi.fn(async (_project: string, _body: Blob) => ({ object_id: `sha256:${'c'.repeat(64)}` })),
    listProjectObjects: vi.fn(async () => ({ items: [{ object_id: `sha256:${mediaSha}`, digest: `sha256:${mediaSha}`, relation: options.existingMedia ? 'managed' : 'available' }], next_cursor: null })),
    importTimeline: vi.fn(async (_project: string, prepared: Record<string, unknown>, idempotencyKey: string) => {
      commits.push(prepared);
      commitKeys.push(idempotencyKey);
      return { timeline_id: 'new-timeline', name: 'Imported Cut', transcript_conflicts: [{ media_id: 'sha256:conflict', message: 'kept project version' }] };
    }),
  };
  return { client, admissions, admissionKeys, uploads, commits, commitKeys };
}

function xhrFactory(uploaded: Array<{ digest: string; blob: Blob; url: string; mediaType: string; expectedDigest: string; idempotencyKey: string }>) {
  return () => {
    const headers: Record<string, string> = {};
    const xhr = {
      upload: {} as XMLHttpRequestUpload,
      status: 201,
      open: vi.fn((_method: string, url: string) => { xhr.url = url; }),
      setRequestHeader: vi.fn((key: string, value: string) => { headers[key] = value; }),
      send: vi.fn((blob: Blob) => {
        uploaded.push({ digest: headers['X-Expected-Digest']!, expectedDigest: headers['X-Expected-Digest']!, blob, url: xhr.url, mediaType: headers['Content-Type']!, idempotencyKey: headers['Idempotency-Key']! });
        xhr.onload?.(new ProgressEvent('load'));
      }),
      onerror: null as ((event: ProgressEvent) => void) | null,
      onabort: null as ((event: ProgressEvent) => void) | null,
      onload: null as ((event: ProgressEvent) => void) | null,
      url: '',
    } as unknown as XMLHttpRequest;
    return xhr;
  };
}

function actionFetch(json: unknown) {
  return vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    expect(String(input)).toContain('/v1/objects/');
    expect(init?.credentials).toBe('omit');
    const body = JSON.stringify(json);
    return new Response(body, { status: 200, headers: { 'Content-Type': 'application/json', 'Content-Length': String(new TextEncoder().encode(body).length) } });
  }) as typeof fetch;
}

afterEach(() => {
  delete (globalThis as typeof globalThis & { showSaveFilePicker?: unknown }).showSaveFilePicker;
});

describe('timeline transfer workflows', () => {
  it('discovers default Runtime actions through the paired Astrid catalog route', async () => {
    const paths: string[] = [];
    vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL) => {
      const url = new URL(input instanceof Request ? input.url : String(input), 'http://localhost');
      paths.push(url.pathname + url.search);
      expect(classifyPairedRoute(url.pathname + url.search, 'GET')?.service).toBe('astrid');
      const body = JSON.stringify({
        items: [{ capability_id: 'rendering.timeline_export_plan', definition_digest: artifactDigest, status: 'ready', required_resource_keys: [], estimated_scratch_bytes: 0, estimated_output_bytes: 0 }],
        next_cursor: null,
      });
      return new Response(body, { status: 200, headers: { 'Content-Type': 'application/json' } });
    }));
    (globalThis as typeof globalThis & { showSaveFilePicker?: unknown }).showSaveFilePicker = vi.fn(async () => ({ createWritable: async () => new WritableStream<Uint8Array>() }));
    const plan = { manifest: { format: 'astrid.timeline/1', elements: [], media: [], transcripts: [] }, timeline: {}, transcripts: {}, media: [] };
    const client = {
      admitTask: vi.fn(async () => ({ task_id: 'task', state: 'succeeded' })),
      getTask: vi.fn(),
      listManagedOutputs: vi.fn(async () => ({ items: [{ output_port: 'plan', digest: artifactDigest }], next_cursor: null })),
      ingestProjectObject: vi.fn(), listProjectObjects: vi.fn(), importTimeline: vi.fn(),
    };
    await exportTimelineArchive(
      { projectId: 'catalog-route-test', timelineId: 'timeline', timelineName: 'Catalog route', flushPendingSave: async () => undefined },
      { client: client as never, fetchImpl: actionFetch(plan) },
    );
    expect(download).toHaveBeenCalledWith(expect.any(Blob), 'Catalog route.astrid');
    expect((globalThis as typeof globalThis & { showSaveFilePicker?: unknown }).showSaveFilePicker).not.toHaveBeenCalled();
    expect(paths).toEqual(['/api/astrid/v1/capabilities?limit=100']);
    expect(paths.some((path) => path === '/api/runtime/v1/capabilities')).toBe(false);
  });

  it('acquires the save handle in the click call before flushing and streams the returned plan artifact', async () => {
    const writes: Uint8Array[] = [];
    const order: string[] = [];
    const errors: string[] = [];
    (globalThis as typeof globalThis & { showSaveFilePicker?: unknown }).showSaveFilePicker = vi.fn(async () => {
      order.push('picker');
      return { createWritable: async () => new WritableStream({ write(chunk) { writes.push(chunk.slice()); } }) };
    });
    const mediaBytes = new TextEncoder().encode('media-stream');
    const plan = { manifest: { format: 'astrid.timeline/1', name: 'Timeline', media: [{ sha256: mediaSha, size: mediaBytes.length }], elements: [], transcripts: [] }, timeline: { timeline_id: 't' }, transcripts: {}, media: [{ sha256: mediaSha, size: mediaBytes.length, original_name: 'clip.mp4' }] };
    const client = {
      listCapabilities: vi.fn(async () => ({ items: [{ capability_id: 'rendering.timeline_export_plan', definition_digest: 'sha256:cap', status: 'ready', estimated_scratch_bytes: 0, estimated_output_bytes: 1 }], next_cursor: null })),
      admitTask: vi.fn(async (input: Record<string, unknown>) => { order.push('admit'); expect(input.spec).toEqual({ capability_id: 'rendering.timeline_export_plan', kind: 'action', inputs: { project: 'p', timeline: 't' }, outputs: {}, extra_pack_roots: [] }); return { task_id: 'export-task', state: 'succeeded' }; }),
      getTask: vi.fn(),
      listManagedOutputs: vi.fn(async () => ({ items: [{ output_port: 'plan', digest: artifactDigest, size: new TextEncoder().encode(JSON.stringify(plan)).length }], next_cursor: null })),
      ingestProjectObject: vi.fn(), listProjectObjects: vi.fn(), importProjectMedia: vi.fn(), importTimeline: vi.fn(),
    };
    const fetchImpl = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      expect(init?.credentials).toBe('omit');
      return String(input).endsWith(mediaSha)
        ? new Response(mediaBytes)
        : new Response(JSON.stringify(plan), { status: 200 });
    }) as typeof fetch;
    await exportTimelineArchive({ projectId: 'p', timelineId: 't', timelineName: 'Timeline', flushPendingSave: async () => { order.push('flush'); } }, { saveAs: true, client: client as never, fetchImpl, toast: { loading: () => 'x', update: () => undefined, success: () => undefined, warning: () => undefined, error: (message, _id, description) => errors.push(`${message}: ${description}`) } });
    expect(order).toEqual(['picker', 'flush', 'admit']);
    expect(errors).toEqual([]);
    expect(writes.length).toBeGreaterThan(0);
    const archive = new Blob(writes);
    const exported = await readStoredZip(archive);
    expect(exported.map((entry) => entry.name)).toEqual(['manifest.json', 'timeline.json', `media/${mediaSha}`]);
    expect(await exported[2]!.blob.text()).toBe('media-stream');
  });

  it('cancels the live object response when the save destination fails under backpressure', async () => {
    let cancelled = false;
    let pulls = 0;
    let writeCount = 0;
    const bytes = new Uint8Array([1, 2, 3, 4]);
    const plan = { manifest: { format: 'astrid.timeline/1', media: [{ sha256: mediaSha, size: bytes.length }], elements: [], transcripts: [] }, timeline: {}, transcripts: {}, media: [{ sha256: mediaSha, size: bytes.length }] };
    const mediaBody = new ReadableStream<Uint8Array>({
      pull(controller) { pulls += 1; controller.enqueue(bytes); },
      cancel() { cancelled = true; },
    });
    (globalThis as typeof globalThis & { showSaveFilePicker?: unknown }).showSaveFilePicker = vi.fn(async () => ({
      createWritable: async () => new WritableStream<Uint8Array>({ write() { if (++writeCount === 8) throw new Error('disk full'); } }),
    }));
    const client = {
      listCapabilities: vi.fn(async () => ({ items: [{ capability_id: 'rendering.timeline_export_plan', definition_digest: 'sha256:cap', status: 'ready', estimated_scratch_bytes: 0, estimated_output_bytes: 0 }], next_cursor: null })),
      admitTask: vi.fn(async () => ({ task_id: 'export-task', state: 'succeeded' })),
      getTask: vi.fn(),
      listManagedOutputs: vi.fn(async () => ({ items: [{ output_port: 'plan', digest: artifactDigest, size: new TextEncoder().encode(JSON.stringify(plan)).length }], next_cursor: null })),
      ingestProjectObject: vi.fn(), listProjectObjects: vi.fn(), importTimeline: vi.fn(),
    };
    const errors: string[] = [];
    const fetchImpl = vi.fn(async (url: RequestInfo | URL) => String(url).endsWith(mediaSha)
      ? new Response(mediaBody)
      : new Response(JSON.stringify(plan))) as typeof fetch;
    await exportTimelineArchive({ projectId: 'p', timelineId: 't', timelineName: 'T', flushPendingSave: async () => undefined }, {
      saveAs: true, client: client as never, fetchImpl, toast: { loading: () => 'toast', update: () => undefined, success: () => undefined, warning: () => undefined, error: (message, _id, description) => errors.push(`${message}: ${description}`) },
    });
    expect(errors).toContain("Couldn't export T: disk full");
    expect(cancelled).toBe(true);
    expect(pulls).toBeLessThanOrEqual(3);
  });

  it('does not export after a save failure and applies the named large-archive fallback rule', async () => {
    const picker = vi.fn(async () => ({ createWritable: async () => new WritableStream<Uint8Array>() }));
    (globalThis as typeof globalThis & { showSaveFilePicker?: unknown }).showSaveFilePicker = picker;
    const client = { listCapabilities: vi.fn(), admitTask: vi.fn(), getTask: vi.fn(), listManagedOutputs: vi.fn(), ingestProjectObject: vi.fn(), listProjectObjects: vi.fn(), importProjectMedia: vi.fn(), importTimeline: vi.fn() };
    await exportTimelineArchive({ projectId: 'p', timelineId: 't', timelineName: 'T', flushPendingSave: async () => { throw new Error('save failed'); } }, { client: client as never });
    expect(client.admitTask).not.toHaveBeenCalled();
    expect(picker).not.toHaveBeenCalled();

    delete (globalThis as typeof globalThis & { showSaveFilePicker?: unknown }).showSaveFilePicker;
    const largePlan = { manifest: { format: 'astrid.timeline/1', name: 'Large', elements: [], media: [{ sha256: mediaSha, size: 1024 * 1024 * 1024 }], transcripts: [] }, timeline: {}, transcripts: {}, media: [{ sha256: mediaSha, size: 1024 * 1024 * 1024 }] };
    const largeClient = {
      listCapabilities: vi.fn(async () => ({ items: [{ capability_id: 'rendering.timeline_export_plan', definition_digest: 'd', status: 'ready', estimated_scratch_bytes: 0, estimated_output_bytes: 0 }], next_cursor: null })),
      admitTask: vi.fn(async () => ({ task_id: 'large', state: 'succeeded' })), getTask: vi.fn(),
      listManagedOutputs: vi.fn(async () => ({ items: [{ output_port: 'plan', digest: artifactDigest }], next_cursor: null })),
      ingestProjectObject: vi.fn(), getProjectObjectLocation: vi.fn(), importProjectMedia: vi.fn(), importTimeline: vi.fn(),
    };
    const errors: string[] = [];
    await exportTimelineArchive({ projectId: 'p', timelineId: 't', timelineName: 'Large', flushPendingSave: async () => undefined }, { client: largeClient as never, fetchImpl: actionFetch(largePlan), toast: { loading: () => 'x', update: () => undefined, success: () => undefined, warning: () => undefined, error: (message, _id, description) => errors.push(`${message}: ${description}`) } });
    expect(errors.join(' ')).toContain('Choose Save timeline as…');
  });

  it('preflights before uploads, sends expected digests, and commits the prepared artifact', async () => {
    const { client, admissions, admissionKeys, uploads, commits, commitKeys } = fakeClient();
    const fetchImpl = actionFetch({ format: 'astrid.timeline/1', elements: [] });
    let actionIndex = 0;
    fetchImpl.mockImplementation(async (_input, init) => {
      expect(init?.credentials).toBe('omit');
      actionIndex += 1;
      const body = JSON.stringify(actionIndex === 1
        ? { check_only: true, name: 'Imported Cut', missing_effects: ['am-callout'], different_effects: [] }
        : preparedJson());
      return new Response(body, { status: 200, headers: { 'Content-Length': String(new TextEncoder().encode(body).length) } });
    });
    const imported = await importTimelineArchive(new File([await archiveBlob()], 'timeline.astrid'), 'target-project', {
      client: client as never, fetchImpl, xhrFactory: xhrFactory(uploads),
    });
    expect(admissions).toHaveLength(2);
    expect((admissions[0]!.spec as { inputs: Record<string, unknown> }).inputs).toEqual({ project: 'target-project', manifest: { format: 'astrid.timeline/1', elements: [] }, check_only: true });
    expect((admissions[1]!.input_object_ids as string[])).toContain(`sha256:${'c'.repeat(64)}`);
    expect((admissions[1]!.spec as { input_digests: Array<{ name: string; digest: string }> }).input_digests).toContainEqual({ name: 'payload', digest: `sha256:${'c'.repeat(64)}` });
    expect(uploads).toEqual([{ digest: `sha256:${mediaSha}`, expectedDigest: `sha256:${mediaSha}`, blob: expect.any(Blob), url: expect.stringContaining('/v1/projects/target-project/objects'), mediaType: 'video/mp4', idempotencyKey: expect.stringMatching(/^[A-Za-z0-9][A-Za-z0-9._~-]{0,255}$/) }]);
    expect(admissionKeys).toHaveLength(2);
    admissionKeys.forEach((key) => expect(key).toMatch(/^[A-Za-z0-9][A-Za-z0-9._~-]{0,255}$/));
    expect(client.listProjectObjects).toHaveBeenCalledWith('target-project', undefined, 100);
    expect(commits).toHaveLength(1);
    expect(commitKeys).toHaveLength(1);
    commitKeys.forEach((key) => expect(key).toMatch(/^[A-Za-z0-9][A-Za-z0-9._~-]{0,255}$/));
    expect(imported.timeline_id).toBe('new-timeline');
    expect((client.ingestProjectObject as unknown as ReturnType<typeof vi.fn>)).toHaveBeenCalled();
  });

  it('numbers a taken timeline name like "Timeline N"', () => {
    expect(uniqueTimelineName('Cut', ['Other'])).toBe('Cut');
    expect(uniqueTimelineName('Cut', ['cut'])).toBe('Cut 2');
    expect(uniqueTimelineName('Cut', ['Cut', 'Cut 2'])).toBe('Cut 3');
  });

  it('names a duplicate import and, when the user moved away, says where to open it', async () => {
    const { client, admissions, uploads } = fakeClient();
    const fetchImpl = actionFetch({ format: 'astrid.timeline/1', elements: [] });
    let actionIndex = 0;
    fetchImpl.mockImplementation(async () => {
      actionIndex += 1;
      const body = JSON.stringify(actionIndex === 1 ? { check_only: true, name: 'Imported Cut', missing_effects: [], different_effects: [] } : preparedJson());
      return new Response(body, { status: 200, headers: { 'Content-Length': String(new TextEncoder().encode(body).length) } });
    });
    const results: string[] = [];
    const onImported = vi.fn(async () => false);
    await importTimelineArchive(new File([await archiveBlob()], 'Cut.astrid'), 'target-project', {
      client: client as never, fetchImpl, xhrFactory: xhrFactory(uploads), existingNames: ['Imported Cut'], onImported,
      toast: { loading: () => 'toast', update: () => undefined, success: (m, _id, d) => results.push(`success ${m} ${d ?? ''}`), warning: (m, _id, d) => results.push(`warning ${m} ${d ?? ''}`), error: () => undefined },
    });
    expect((admissions[1]!.spec as { inputs: Record<string, unknown> }).inputs.name).toBe('Imported Cut 2');
    expect(onImported).toHaveBeenCalledWith('new-timeline');
    expect(results.join('\n')).toContain('Open it from the Timeline menu.');
  });

  it('stops on a failed manifest preflight before media upload', async () => {
    const { client, uploads } = fakeClient({ checkFails: true });
    await expect(importTimelineArchive(new File([await archiveBlob()], 'timeline.astrid'), 'target-project', {
      client: client as never, fetchImpl: actionFetch({}), xhrFactory: xhrFactory(uploads),
    })).rejects.toThrow('stale pin');
    expect(client.listProjectObjects).not.toHaveBeenCalled();
    expect(uploads).toHaveLength(0);
  });

  it('rejects unlisted archive entries before preflight or uploads', async () => {
    const { client, uploads } = fakeClient();
    const result = importTimelineArchive(new File([await archiveBlob(true, [{ name: `transcripts/${'d'.repeat(64)}.whisper.json`, value: '{}' }])], 'timeline.astrid'), 'target-project', {
      client: client as never, fetchImpl: actionFetch({}), xhrFactory: xhrFactory(uploads),
    });
    await expect(result).rejects.toThrow('unlisted entry');
    expect(client.admitTask).not.toHaveBeenCalled();
    expect(uploads).toHaveLength(0);
  });

  it('rejects incomplete manifest arrays before invoking Runtime preflight', async () => {
    const incomplete = { format: 'astrid.timeline/1', name: 'Broken', media: [], elements: [] };
    const bytes = new TextEncoder().encode(JSON.stringify(incomplete));
    const chunks: Uint8Array[] = [];
    await writeStoredZip([
      { name: 'manifest.json', size: bytes.length, stream: () => new ReadableStream({ start(controller) { controller.enqueue(bytes); controller.close(); } }) },
      { name: 'timeline.json', size: 2, stream: () => new ReadableStream({ start(controller) { controller.enqueue(new TextEncoder().encode('{}')); controller.close(); } }) },
    ], new WritableStream({ write(chunk) { chunks.push(chunk.slice()); } }));
    const { client, uploads } = fakeClient();
    await expect(importTimelineArchive(new File(chunks, 'broken.astrid'), 'target-project', { client: client as never, fetchImpl: actionFetch({}), xhrFactory: xhrFactory(uploads) })).rejects.toThrow('must be arrays');
    expect(client.admitTask).not.toHaveBeenCalled();
  });

  it('rejects transcript entries whose filename identity disagrees with their content', async () => {
    const name = `transcripts/${mediaSha}.whisper.json`;
    const transcript = { name, value: JSON.stringify({ schema: 'media.transcript/v1', media_id: `sha256:${mediaSha}`, source_id: 'different-source' }) };
    const { client } = fakeClient();
    await expect(importTimelineArchive(new File([await archiveBlob(true, [], 'video/mp4', transcript)], 'timeline.astrid'), 'target-project', { client: client as never, fetchImpl: actionFetch({}) })).rejects.toThrow('does not match its media and source identity');
    expect(client.admitTask).not.toHaveBeenCalled();
  });

  it('uploads text binding bytes as a target-managed raw CAS object', async () => {
    const { client, uploads } = fakeClient();
    let actionIndex = 0;
    const fetchImpl = actionFetch({});
    fetchImpl.mockImplementation(async () => new Response(JSON.stringify(++actionIndex === 1
      ? { check_only: true, missing_effects: [], different_effects: [] }
      : preparedJson()), { status: 200 }));
    await importTimelineArchive(new File([await archiveBlob(true, [], 'text/plain; charset=utf-8')], 'timeline.astrid'), 'target-project', {
      client: client as never, fetchImpl, xhrFactory: xhrFactory(uploads),
    });
    expect(uploads).toHaveLength(1);
    expect(uploads[0]).toMatchObject({ url: expect.stringContaining('/v1/projects/target-project/objects'), mediaType: 'text/plain; charset=utf-8', expectedDigest: `sha256:${mediaSha}` });
  });

  it('refuses a prepared publication whose dependency media differs from the archive', async () => {
    const { client, uploads, commits } = fakeClient();
    let actionIndex = 0;
    const fetchImpl = actionFetch({});
    fetchImpl.mockImplementation(async () => new Response(JSON.stringify(++actionIndex === 1
      ? { check_only: true, missing_effects: [], different_effects: [] }
      : preparedJson(false)), { status: 200 }));
    await expect(importTimelineArchive(new File([await archiveBlob()], 'timeline.astrid'), 'target-project', {
      client: client as never, fetchImpl, xhrFactory: xhrFactory(uploads),
    })).rejects.toThrow('does not match the archive media manifest');
    expect(uploads).toHaveLength(1);
    expect(commits).toHaveLength(0);
  });

  it('skips a target-project managed object but reuploads a same-CAS nonmanaged relation', async () => {
    const managed = fakeClient({ existingMedia: true });
    let actionIndex = 0;
    const fetchImpl = actionFetch({});
    fetchImpl.mockImplementation(async () => new Response(JSON.stringify(++actionIndex === 1
      ? { check_only: true, missing_effects: [], different_effects: [] }
      : preparedJson()), { status: 200 }));
    await importTimelineArchive(new File([await archiveBlob()], 'timeline.astrid'), 'target-project', { client: managed.client as never, fetchImpl, xhrFactory: xhrFactory(managed.uploads) });
    expect(managed.uploads).toHaveLength(0);

    const shared = fakeClient({ existingMedia: false });
    actionIndex = 0;
    await importTimelineArchive(new File([await archiveBlob()], 'timeline.astrid'), 'target-project', { client: shared.client as never, fetchImpl, xhrFactory: xhrFactory(shared.uploads) });
    expect(shared.uploads).toHaveLength(1);
  });
});
