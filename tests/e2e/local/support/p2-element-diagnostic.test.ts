import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readFileSync, statSync } from 'node:fs';
import { test } from 'node:test';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runInNewContext } from 'node:vm';
import type { Request, Response } from '@playwright/test';
import { ElementApplyDiagnosticCollector, closeElementApplyDiagnosticContext, elementApplyDiagnosticPageFixture, installElementApplyDiagnostic, readElementApplyUiState, retainElementApplyDiagnostic, serializeElementApplyDiagnostic, type ElementApplyDiagnosticArtifact } from './p2-element-diagnostic.ts';

function applyBody(intent = 'timeline.apply_element'): Record<string, unknown> {
  const changes = [{ op: 'list.insert', ref: 'parent', path: ['config', 'clips'], before: { state: 'absent' }, id: 'element-1', value: { id: 'element-1' }, order_before: [], after_id: null }];
  return {
    api_version: 1, project_id: 'private-project', timeline_id: 'private-timeline', base_revision_id: 'private-revision', base_publication_id: 'private-publication',
    commands: [{ schema_version: 1, op: 'doc.patch', version: '1', select: null, created: ['parent/clip:element-1'], args: { changes } }],
    label: 'Edit timeline', merge: 'atomic', reads: [], dry_run: false, source: { via: 'app' },
    steps: [{ id: 'private-step', label: 'Edit timeline', intent, tags: [], command_ordinals: [0], patch: changes, reads: [] }],
  };
}

function request(failure?: string, kind: 'target' | 'unrelated' = 'target', route = '/v1'): Request {
  return {
    method: () => 'POST',
    url: () => `https://runtime.invalid${route}/projects/private/timelines/private/commit?secret=private`,
    headers: () => ({ 'idempotency-key': 'private-key', authorization: 'Bearer private' }),
    failure: () => failure ? { errorText: failure } : null,
    postDataJSON: () => kind === 'target' ? applyBody() : { ...applyBody('other.operation'), authorization: 'Bearer body-secret' },
  } as unknown as Request;
}

function response(source: Request, status: number): Response {
  return { request: () => source, status: () => status } as unknown as Response;
}

function stages(collector: ElementApplyDiagnosticCollector): string[] {
  return collector.snapshot().events.map((event) => event.stage);
}

function installerPage(): { page: unknown; emit(event: string, value?: unknown): void; apply(): void } {
  const listeners = new Map<string, Array<(value?: unknown) => void>>();
  let exposed: (() => void) | undefined;
  let releaseExpose: (() => void) | undefined;
  const page = {
    on(event: string, listener: (value?: unknown) => void) {
      listeners.set(event, [...(listeners.get(event) ?? []), listener]);
    },
    exposeFunction(_name: string, callback: () => void) {
      exposed = callback;
      return new Promise<void>((resolve) => { releaseExpose = resolve; });
    },
    addInitScript: async () => {},
  };
  return {
    page,
    emit(event, value) { for (const listener of listeners.get(event) ?? []) listener(value); },
    apply() { exposed?.(); releaseExpose?.(); },
  };
}

test('accepted Apply records the real boundary, scoped request and response in order', () => {
  const collector = new ElementApplyDiagnosticCollector();
  const post = request();
  collector.recordApplyClick();
  collector.recordRequest(post);
  collector.recordResponse(response(post, 200));
  assert.deepEqual(stages(collector), ['apply-click', 'request-start', 'response']);
  const snapshot = collector.snapshot();
  assert.equal(snapshot.terminal, 'accepted');
  assert.equal(snapshot.events[1]?.request, 'scoped-commit');
  assert.equal(snapshot.events[1]?.idempotencyKey, 'present');
  assert.equal(snapshot.events[2]?.responseStatus, 200);
  assert.equal(snapshot.events[2]?.terminal, 'accepted');
  assert.doesNotMatch(JSON.stringify(snapshot), /runtime\.invalid|private-key|Bearer|authorization|secret/);
});

test('the installer retains a fast target POST before the expose callback and ignores an unrelated commit', async () => {
  const collector = new ElementApplyDiagnosticCollector();
  const mock = installerPage();
  const install = installElementApplyDiagnostic(mock.page as never, collector);
  const target = request(undefined, 'target', '/api/runtime/v1');
  mock.emit('request', target);
  mock.emit('request', request(undefined, 'unrelated', '/api/runtime/v1'));
  mock.emit('response', response(target, 201));
  mock.apply();
  await install;
  mock.emit('close');
  assert.deepEqual(stages(collector), ['apply-click', 'request-start', 'response', 'page-close']);
  assert.equal(collector.snapshot().terminal, 'accepted');
  assert.equal(collector.snapshot().events[1]?.request, 'scoped-commit');
});

test('the installed target failure remains failed through page close', async () => {
  const collector = new ElementApplyDiagnosticCollector();
  const mock = installerPage();
  const install = installElementApplyDiagnostic(mock.page as never, collector);
  mock.apply();
  const target = request('net::ERR_FAILED', 'target', '/api/runtime/v1');
  mock.emit('request', target);
  mock.emit('requestfailed', target);
  await install;
  mock.emit('close');
  assert.deepEqual(stages(collector), ['apply-click', 'request-start', 'request-failed', 'page-close']);
  assert.equal(collector.snapshot().terminal, 'failed');
});

test('an error response is terminal failed and is not relabeled as accepted', () => {
  const collector = new ElementApplyDiagnosticCollector();
  const post = request();
  collector.recordApplyClick();
  collector.recordRequest(post);
  collector.recordResponse(response(post, 409));
  const event = collector.snapshot().events.at(-1);
  assert.equal(event?.stage, 'response');
  assert.equal(event?.response, 'failure');
  assert.equal(event?.terminal, 'failed');
  assert.equal(collector.snapshot().terminal, 'failed');
});

test('request abort records aborted even when no response exists', () => {
  const collector = new ElementApplyDiagnosticCollector();
  const post = request('net::ERR_ABORTED');
  collector.recordApplyClick();
  collector.recordRequest(post);
  collector.recordRequestFailed(post);
  const event = collector.snapshot().events.at(-1);
  assert.equal(event?.stage, 'request-failed');
  assert.equal(event?.failure, 'aborted');
  assert.equal(event?.terminal, 'aborted');
  assert.equal(collector.snapshot().pageClosed, false);
});

test('page close retains pending versus unknown without inventing a response', () => {
  const pending = new ElementApplyDiagnosticCollector();
  const post = request();
  pending.recordApplyClick();
  pending.recordRequest(post);
  pending.recordPageClose();
  assert.equal(pending.snapshot().terminal, 'pending');
  assert.equal(pending.snapshot().events.at(-1)?.stage, 'page-close');
  assert.equal(pending.snapshot().events.at(-1)?.responseStatus, 'UNKNOWN');

  const unknown = new ElementApplyDiagnosticCollector();
  unknown.recordApplyClick();
  unknown.recordPageClose();
  assert.equal(unknown.snapshot().terminal, 'unknown');
  assert.equal(unknown.snapshot().events.at(-1)?.terminal, 'unknown');
});

test('the retained writer emits bounded JSON for a failed page close', async () => {
  const directory = mkdtempSync(join(process.env.TMPDIR ?? tmpdir(), 'p2-element-diagnostic-'));
  const output = join(directory, 'p2-element-apply-diagnostic.json');
  const collector = new ElementApplyDiagnosticCollector();
  collector.recordApplyClick();
  collector.recordPageClose();
  const attached: string[] = [];
  const retained = await retainElementApplyDiagnostic({
    outputPath(name) { assert.equal(name, 'p2-element-apply-diagnostic.json'); return output; },
    async attach(name, options) { attached.push(name); assert.equal(options.contentType, 'application/json'); },
  }, undefined, collector, 'failed');
  assert.equal(retained, true);
  assert.deepEqual(attached, ['p2-element-apply-diagnostic.json']);
  const artifact = JSON.parse(readFileSync(output, 'utf8')) as ElementApplyDiagnosticArtifact;
  assert.equal(artifact.status, 'observed');
  assert.equal(artifact.lifecycle.testOutcome, 'failed');
  assert.equal(artifact.lifecycle.pageClosed, true);
  assert.equal((artifact.diagnostic as Exclude<ElementApplyDiagnosticArtifact['diagnostic'], 'UNKNOWN'>).events.at(-1)?.terminal, 'unknown');
  assert.ok(readFileSync(output, 'utf8').length < 24 * 1024);
});

test('the retained writer keeps real allowlisted page state and redacts malicious fields', async () => {
  const priorDocument = (globalThis as { document?: unknown }).document;
  const priorButton = (globalThis as { __timelineP2ElementApplyButton?: unknown }).__timelineP2ElementApplyButton;
  const dialog = {};
  const button = { disabled: false, closest: () => dialog };
  (globalThis as { document?: unknown }).document = {
    querySelector(selector: string) {
      if (selector === '[data-testid="runtime-connection-status"]') return { getAttribute: () => 'connected' };
      if (selector === '[role="dialog"]') return dialog;
      return null;
    },
  };
  (globalThis as { __timelineP2ElementApplyButton?: unknown }).__timelineP2ElementApplyButton = button;
  try {
    assert.deepEqual(readElementApplyUiState('accepted'), { stage: 'retained', connection: 'connected', dialog: 'present', status: 'applied', applyButton: 'applied' });
    button.disabled = true;
    assert.deepEqual(readElementApplyUiState('pending'), { stage: 'retained', connection: 'connected', dialog: 'present', status: 'pending', applyButton: 'applying' });
    button.disabled = false;
    assert.deepEqual(readElementApplyUiState(), { stage: 'retained', connection: 'connected', dialog: 'present', status: 'unknown', applyButton: 'idle' });
    assert.deepEqual(readElementApplyUiState('failed'), { stage: 'retained', connection: 'connected', dialog: 'present', status: 'failed', applyButton: 'refused' });
    button.closest = () => null;
    assert.deepEqual(readElementApplyUiState('accepted'), { stage: 'retained', connection: 'connected', dialog: 'present', status: 'unknown', applyButton: 'unknown' });
  } finally {
    if (priorDocument === undefined) delete (globalThis as { document?: unknown }).document;
    else (globalThis as { document?: unknown }).document = priorDocument;
    if (priorButton === undefined) delete (globalThis as { __timelineP2ElementApplyButton?: unknown }).__timelineP2ElementApplyButton;
    else (globalThis as { __timelineP2ElementApplyButton?: unknown }).__timelineP2ElementApplyButton = priorButton;
  }
  const directory = mkdtempSync(join(process.env.TMPDIR ?? tmpdir(), 'p2-element-diagnostic-ui-'));
  const output = join(directory, 'p2-element-apply-diagnostic.json');
  const collector = new ElementApplyDiagnosticCollector();
  collector.recordApplyClick();
  const retained = await retainElementApplyDiagnostic({
    outputPath() { return output; },
    async attach() {},
  }, { evaluate: async () => ({ stage: 'retained', connection: 'connected', dialog: 'present', status: 'applied', applyButton: 'applied', authorization: 'Bearer secret', domText: 'private DOM text' }) }, collector, 'passed');
  assert.equal(retained, true);
  const serialized = readFileSync(output, 'utf8');
  assert.doesNotMatch(serialized, /Bearer secret|private DOM text|authorization|domText/);
  assert.match(serialized, /"connection":"connected"/);
});

test('the actual evaluated UI sampler is self-contained and only returns bounded state', () => {
  const dialog = { textContent: 'Applied private DOM text', dataset: { secret: 'private data' } };
  const button: { disabled: boolean; textContent: string; closest: () => typeof dialog | null } = { disabled: false, textContent: 'Apply private text', closest: () => dialog };
  const document = {
    querySelector(selector: string) {
      if (selector === '[data-testid="runtime-connection-status"]') return { getAttribute: () => 'connected' };
      if (selector === '[role="dialog"]') return dialog;
      throw new Error('unexpected selector');
    },
  };
  const context = { document, __timelineP2ElementApplyButton: button };
  const readInBrowser = runInNewContext(`(${readElementApplyUiState.toString()})`, context) as (terminal?: string) => unknown;
  const readState = (terminal?: string) => JSON.parse(JSON.stringify(readInBrowser(terminal))) as Record<string, string>;

  assert.deepEqual(readState(), { stage: 'retained', connection: 'connected', dialog: 'present', status: 'unknown', applyButton: 'idle' });
  button.disabled = true;
  assert.deepEqual(readState('pending'), { stage: 'retained', connection: 'connected', dialog: 'present', status: 'pending', applyButton: 'applying' });
  button.disabled = false;
  assert.deepEqual(readState('accepted'), { stage: 'retained', connection: 'connected', dialog: 'present', status: 'applied', applyButton: 'applied' });
  assert.deepEqual(readState('failed'), { stage: 'retained', connection: 'connected', dialog: 'present', status: 'failed', applyButton: 'refused' });
  assert.deepEqual(readState('unexpected'), { stage: 'retained', connection: 'connected', dialog: 'present', status: 'unknown', applyButton: 'idle' });
  button.closest = () => null;
  assert.deepEqual(readState('accepted'), { stage: 'retained', connection: 'connected', dialog: 'present', status: 'unknown', applyButton: 'unknown' });
  assert.doesNotMatch(JSON.stringify(readState('accepted')), /private|text|data|secret/);

  const malformedContext = { document: { querySelector: () => { throw new Error('malformed document'); } } };
  const readMalformed = runInNewContext(`(${readElementApplyUiState.toString()})`, malformedContext) as () => unknown;
  assert.deepEqual(JSON.parse(JSON.stringify(readMalformed())), { stage: 'unknown', connection: 'unknown', dialog: 'unknown', status: 'unknown', applyButton: 'unknown' });
});

test('the collector caps retained events at its bound', () => {
  const collector = new ElementApplyDiagnosticCollector();
  for (let index = 0; index < 40; index += 1) collector.recordApplyClick();
  const events = collector.snapshot().events;
  assert.equal(events.length, 24);
  assert.equal(events.at(-1)?.sequence, 40);
  assert.equal(collector.eventsLost, true);
});

test('an attachment failure is reported instead of success', async () => {
  const directory = mkdtempSync(join(process.env.TMPDIR ?? tmpdir(), 'p2-element-diagnostic-attach-'));
  const collector = new ElementApplyDiagnosticCollector();
  collector.recordApplyClick();
  const retained = await retainElementApplyDiagnostic({
    outputPath() { return join(directory, 'p2-element-apply-diagnostic.json'); },
    async attach() { throw new Error('attachment failed'); },
  }, undefined, collector, 'failed');
  assert.equal(retained, false);
});

test('serialization falls back to the safe loss marker when supplied data exceeds the bound', () => {
  const artifact = {
    version: 1 as const,
    kind: 'p2-element-apply-lifecycle' as const,
    status: 'observed' as const,
    lifecycle: { testOutcome: 'failed' as const, beforePageClose: true, pageClosed: false },
    diagnostic: 'x'.repeat(100_000) as 'UNKNOWN',
    losses: { write: false, events: false, ui: false },
  } satisfies ElementApplyDiagnosticArtifact;
  const serialized = serializeElementApplyDiagnostic(artifact);
  assert.match(serialized, /"diagnostic":"UNKNOWN"/);
  assert.ok(Buffer.byteLength(serialized) < 24 * 1024);
});


test('the actual fixture retains late response/finish through context teardown and attaches identical final bytes', async () => {
  const directory = mkdtempSync(join(process.env.TMPDIR ?? tmpdir(), 'p2-element-fixture-'));
  const output = join(directory, 'p2-element-apply-diagnostic.json');
  const mock = installerPage();
  const target = request();
  let beforeClose: ElementApplyDiagnosticArtifact | undefined;
  let attachment: string | undefined;
  const page = Object.assign(mock.page as object, {
    evaluate: async () => ({ stage: 'retained', connection: 'connected', dialog: 'present', status: 'unknown' }),
    async close() {
      beforeClose = JSON.parse(readFileSync(output, 'utf8'));
      mock.emit('response', response(target, 200));
      mock.emit('requestfinished', target);
      mock.emit('close');
    },
  });
  const context = {
    async newPage() { setImmediate(() => mock.apply()); return page; },
    async close() {},
  };
  await elementApplyDiagnosticPageFixture({ context: context as never }, async () => {
    mock.emit('request', target);
  }, { outputPath: () => output, status: 'failed', async attach(_name, options) { attachment = readFileSync(options.path, 'utf8'); } });
  assert.equal(beforeClose?.diagnostic === 'UNKNOWN' ? undefined : beforeClose?.diagnostic.terminal, 'pending');
  assert.equal(attachment, undefined, 'attachment must wait for context teardown');
  await closeElementApplyDiagnosticContext(context as never);
  const bytes = readFileSync(output, 'utf8');
  assert.equal(attachment, bytes);
  const artifact = JSON.parse(bytes) as ElementApplyDiagnosticArtifact;
  assert.equal(artifact.lifecycle.beforePageClose, true);
  assert.equal(artifact.lifecycle.pageClosed, true);
  assert.notEqual(artifact.diagnostic, 'UNKNOWN');
  if (artifact.diagnostic === 'UNKNOWN') return;
  assert.equal(artifact.diagnostic.terminal, 'accepted');
  assert.deepEqual(artifact.diagnostic.events.map((event) => event.stage), [
    'apply-click', 'request-start', 'test-outcome', 'retained', 'teardown-start', 'response', 'request-finished', 'page-close',
  ]);
});


test('initial retention must not freeze out a later real response', async () => {
  const directory = mkdtempSync(join(process.env.TMPDIR ?? tmpdir(), 'p2-element-late-'));
  const output = join(directory, 'p2-element-apply-diagnostic.json');
  const collector = new ElementApplyDiagnosticCollector();
  const target = request();
  collector.recordApplyClick();
  collector.recordRequest(target);
  await retainElementApplyDiagnostic({ outputPath: () => output, async attach() {} }, undefined, collector, 'failed', 'initial');
  collector.recordResponse(response(target, 200));
  // Drain the real writer, without a browser or timing change.
  await retainElementApplyDiagnostic({ outputPath: () => output, async attach() {} }, undefined, collector, 'failed', 'final');
  const artifact = JSON.parse(readFileSync(output, 'utf8')) as ElementApplyDiagnosticArtifact;
  assert.equal(artifact.diagnostic === 'UNKNOWN' ? undefined : artifact.diagnostic.terminal, 'accepted');
});


for (const terminal of ['aborted', 'failed', 'pending'] as const) {
  test(`the actual fixture preserves the UI assertion failure and ${terminal} after page close`, async () => {
    const directory = mkdtempSync(join(process.env.TMPDIR ?? tmpdir(), 'p2-element-late-close-'));
    const output = join(directory, 'p2-element-apply-diagnostic.json');
    const mock = installerPage();
    const target = request(terminal === 'aborted' ? 'net::ERR_ABORTED private-url' : terminal === 'failed' ? 'net::ERR_FAILED private-url' : undefined);
    let attachment: string | undefined;
    const order: string[] = [];
    const assertion = new Error('primary UI assertion');
    const page = Object.assign(mock.page as object, {
      evaluate: async () => ({ stage: 'retained', connection: 'connected', dialog: 'present', status: 'unknown' }),
      async close() {
        order.push('page-close');
        const initial = JSON.parse(readFileSync(output, 'utf8')) as ElementApplyDiagnosticArtifact;
        assert.equal(initial.diagnostic === 'UNKNOWN' ? undefined : initial.diagnostic.terminal, 'pending');
        assert.equal(initial.lifecycle.pageClosed, false);
        mock.emit('close');
      },
    });
    const context = {
      async newPage() { setImmediate(() => mock.apply()); return page; },
      async close() {
        order.push('context-close');
        // This arrives after page.close() resolved: the old writer lost it.
        if (terminal !== 'pending') mock.emit('requestfailed', target);
      },
    };
    await assert.rejects(elementApplyDiagnosticPageFixture({ context: context as never }, async () => {
      mock.emit('request', target);
      throw assertion;
    }, { outputPath: () => output, status: 'failed', async attach(_name, options) {
      order.push('attach');
      attachment = readFileSync(options.path, 'utf8');
    } }), (error) => error === assertion);
    // The page-close event itself cannot claim the request was aborted.
    const afterPageClose = JSON.parse(readFileSync(output, 'utf8')) as ElementApplyDiagnosticArtifact;
    assert.equal(attachment, undefined);
    await closeElementApplyDiagnosticContext(context as never);
    const bytes = readFileSync(output, 'utf8');
    assert.equal(attachment, bytes);
    const artifact = JSON.parse(bytes) as ElementApplyDiagnosticArtifact;
    assert.equal(artifact.lifecycle.testOutcome, 'failed');
    assert.equal(artifact.lifecycle.beforePageClose, true);
    assert.equal(artifact.lifecycle.pageClosed, true);
    assert.notEqual(artifact.diagnostic, 'UNKNOWN');
    if (artifact.diagnostic === 'UNKNOWN') return;
    assert.equal(artifact.diagnostic.terminal, terminal);
    const closed = artifact.diagnostic.events.find((event) => event.stage === 'page-close');
    assert.equal(closed?.terminal, 'pending');
    assert.equal(closed?.failure, 'none');
    assert.equal(closed?.ui.stage, 'closed');
    const retained = artifact.diagnostic.events.find((event) => event.stage === 'retained');
    assert.deepEqual(retained?.ui, { stage: 'retained', connection: 'connected', dialog: 'present', status: 'unknown', applyButton: 'unknown' });
    assert.ok(afterPageClose);
    assert.deepEqual(order, ['page-close', 'context-close', 'attach']);
    assert.doesNotMatch(bytes, /private|primary UI assertion/);
    assert.equal(statSync(output).mode & 0o777, 0o600);
  });
}

test('a finished request without response metadata stays UNKNOWN, never accepted', async () => {
  const collector = new ElementApplyDiagnosticCollector();
  const mock = installerPage();
  const install = installElementApplyDiagnostic(mock.page as never, collector);
  const target = request();
  mock.emit('request', target);
  mock.emit('requestfinished', target);
  mock.apply();
  await install;
  assert.deepEqual(stages(collector), ['apply-click', 'request-start', 'request-finished']);
  assert.equal(collector.snapshot().terminal, 'unknown');
  assert.equal(collector.snapshot().events.at(-1)?.responseStatus, 'UNKNOWN');
});

test('a fast response and finish before the boundary callback keep their real order', async () => {
  const collector = new ElementApplyDiagnosticCollector();
  const mock = installerPage();
  const install = installElementApplyDiagnostic(mock.page as never, collector);
  const target = request();
  mock.emit('request', target);
  mock.emit('response', response(target, 200));
  mock.emit('requestfinished', target);
  mock.apply();
  await install;
  assert.deepEqual(stages(collector), ['apply-click', 'request-start', 'response', 'request-finished']);
  assert.equal(collector.snapshot().terminal, 'accepted');
});

test('an abort after response headers remains an observed abort, not an acceptance', () => {
  const collector = new ElementApplyDiagnosticCollector();
  const target = request('net::ERR_ABORTED');
  collector.recordApplyClick();
  collector.recordRequest(target);
  collector.recordResponse(response(target, 200));
  collector.recordRequestFailed(target);
  assert.equal(collector.snapshot().terminal, 'aborted');
  assert.deepEqual(stages(collector), ['apply-click', 'request-start', 'response', 'request-failed']);
});

test('unrelated and malformed traffic cannot supply a terminal outcome or leak a body', () => {
  for (const mutate of [
    (body: Record<string, unknown>) => ({ ...body, api_version: 2 }),
    (body: Record<string, unknown>) => ({ ...body, steps: [] }),
    (body: Record<string, unknown>) => ({ ...body, source: { via: 'agent' } }),
    () => { throw new Error('private body parse failure'); },
  ]) {
    const collector = new ElementApplyDiagnosticCollector();
    const target = request();
    const malformed = request();
    malformed.postDataJSON = () => mutate(applyBody());
    collector.recordApplyClick();
    collector.recordRequest(target);
    collector.recordRequest(malformed);
    collector.recordResponse(response(malformed, 200));
    collector.recordRequestFailed(malformed);
    collector.recordRequestFinished(malformed);
    assert.equal(collector.snapshot().terminal, 'pending');
    assert.deepEqual(stages(collector), ['apply-click', 'request-start']);
  }
});

test('event overflow keeps the real terminal event and reports event loss in the file', () => {
  const collector = new ElementApplyDiagnosticCollector();
  for (let index = 0; index < 40; index += 1) collector.recordApplyClick();
  const target = request('net::ERR_ABORTED');
  collector.recordRequest(target);
  collector.recordPageClose();
  collector.recordRequestFailed(target);
  const artifact = JSON.parse(serializeElementApplyDiagnostic({ diagnostic: collector.snapshot(), lifecycle: {}, losses: { events: collector.eventsLost } })) as ElementApplyDiagnosticArtifact;
  assert.equal(artifact.losses.events, true);
  if (artifact.diagnostic === 'UNKNOWN') assert.fail('safe bounded snapshot was lost');
  assert.equal(artifact.diagnostic.events.length, 24);
  assert.equal(artifact.diagnostic.events.at(-1)?.stage, 'request-failed');
  assert.equal(artifact.diagnostic.terminal, 'aborted');
});

test('missing request events and bounded pending-request overflow are explicit losses', () => {
  const collector = new ElementApplyDiagnosticCollector();
  collector.recordApplyClick();
  collector.recordResponse(response(request(), 200));
  assert.equal(collector.snapshot().terminal, 'unknown');
  assert.equal(collector.eventsLost, true);
  const pending = new ElementApplyDiagnosticCollector();
  for (let index = 0; index < 9; index += 1) pending.recordRequest(request());
  pending.recordApplyClick();
  assert.equal(pending.eventsLost, true);
});

test('the writer projects every nested key and never invokes untrusted toJSON', () => {
  const collector = new ElementApplyDiagnosticCollector();
  collector.recordApplyClick();
  const marker = { authorization: 'Bearer private', url: 'https://private.invalid', body: 'private body', toJSON() { assert.fail('untrusted toJSON'); } };
  const snapshot = collector.snapshot();
  const artifact = {
    ...marker, lifecycle: { ...marker, testOutcome: 'failed', beforePageClose: true, pageClosed: false },
    diagnostic: { ...snapshot, ...marker, events: snapshot.events.map((event) => ({ ...event, ...marker, ui: { ...event.ui, ...marker } })) },
    losses: { ...marker, write: false, events: false, ui: false },
  };
  const text = serializeElementApplyDiagnostic(artifact);
  assert.doesNotMatch(text, /private|Bearer|authorization|url|body|toJSON/);
  const safe = JSON.parse(text) as ElementApplyDiagnosticArtifact;
  assert.equal(safe.status, 'observed');
  assert.deepEqual(Object.keys(safe).sort(), ['diagnostic', 'kind', 'lifecycle', 'losses', 'status', 'version']);
  assert.deepEqual(Object.keys(safe.lifecycle).sort(), ['beforePageClose', 'pageClosed', 'testOutcome']);
  assert.deepEqual(Object.keys(safe.losses).sort(), ['events', 'ui', 'write']);
  if (safe.diagnostic === 'UNKNOWN') assert.fail('valid diagnostic lost');
  assert.deepEqual(Object.keys(safe.diagnostic).sort(), ['events', 'kind', 'pageClosed', 'terminal', 'version']);
  assert.deepEqual(Object.keys(safe.diagnostic.events[0]!).sort(), ['correlation', 'elapsedMs', 'failure', 'idempotencyKey', 'request', 'response', 'responseStatus', 'sequence', 'stage', 'terminal', 'ui', 'version']);
  assert.deepEqual(Object.keys(safe.diagnostic.events[0]!.ui).sort(), ['applyButton', 'connection', 'dialog', 'stage', 'status']);
});

test('malformed enums, correlations, bounds and nested UI are fail-closed', () => {
  const collector = new ElementApplyDiagnosticCollector();
  collector.recordApplyClick();
  const snapshot = collector.snapshot();
  const event = snapshot.events[0]!;
  for (const bad of [
    { stage: 'Bearer private' }, { terminal: 'private' }, { request: 'private' }, { response: 'private' }, { failure: 'private' },
    { idempotencyKey: 'private-key' }, { correlation: 'apply-private-id' }, { correlation: 'apply-1000000' },
    { sequence: -1 }, { sequence: 1.5 }, { sequence: 1_000_001 }, { elapsedMs: Infinity }, { elapsedMs: -1 }, { elapsedMs: 600_001 },
    { responseStatus: 600 }, { responseStatus: 'private' },
  ]) {
    const text = serializeElementApplyDiagnostic({ diagnostic: { ...snapshot, events: [{ ...event, ...bad }] } });
    assert.doesNotMatch(text, /private|Infinity/);
    const safe = JSON.parse(text) as ElementApplyDiagnosticArtifact;
    assert.equal(safe.losses.events, true);
    if (safe.diagnostic === 'UNKNOWN') assert.fail('bounded diagnostic lost');
    assert.deepEqual(safe.diagnostic.events, []);
  }
  const badUi = JSON.parse(serializeElementApplyDiagnostic({
    lifecycle: { testOutcome: 'private', beforePageClose: 'private', pageClosed: 'private' },
    diagnostic: { ...snapshot, terminal: 'private', pageClosed: 'private', events: [{ ...event, ui: { stage: 'private', status: 'private', connection: 'private', dialog: 'private' } }] },
  })) as ElementApplyDiagnosticArtifact;
  assert.equal(badUi.lifecycle.testOutcome, 'unknown');
  assert.equal(badUi.losses.ui, true);
  assert.equal(badUi.losses.events, true);
  assert.doesNotMatch(JSON.stringify(badUi), /private/);
});

test('the Apply button enum is preserved and malformed UI state is fail-closed', () => {
  const collector = new ElementApplyDiagnosticCollector();
  collector.recordApplyClick();
  const snapshot = collector.snapshot();
  const event = snapshot.events[0]!;
  const applying = JSON.parse(serializeElementApplyDiagnostic({
    diagnostic: { ...snapshot, events: [{ ...event, ui: { stage: 'retained', connection: 'connected', dialog: 'present', status: 'pending', applyButton: 'applying' } }] },
  })) as ElementApplyDiagnosticArtifact;
  if (applying.diagnostic === 'UNKNOWN') assert.fail('bounded Apply button state was lost');
  assert.equal(applying.diagnostic.events[0]?.ui.applyButton, 'applying');

  const malformed = JSON.parse(serializeElementApplyDiagnostic({
    diagnostic: { ...snapshot, events: [{ ...event, ui: { stage: 'retained', connection: 'connected', dialog: 'present', status: 'pending', applyButton: 'private' } }] },
  })) as ElementApplyDiagnosticArtifact;
  assert.equal(malformed.losses.ui, true);
  if (malformed.diagnostic === 'UNKNOWN') assert.fail('bounded malformed UI state was lost');
  assert.equal(malformed.diagnostic.events[0]?.ui.applyButton, 'unknown');
});

test('unavailable UI and a failed output path remain disposable with no fake attachment', async () => {
  const collector = new ElementApplyDiagnosticCollector();
  collector.recordApplyClick();
  const directory = mkdtempSync(join(process.env.TMPDIR ?? tmpdir(), 'p2-element-errors-'));
  const output = join(directory, 'diagnostic.json');
  let attaches = 0;
  assert.equal(await retainElementApplyDiagnostic({ outputPath: () => output, async attach() { attaches += 1; } },
    { evaluate: async () => { throw new Error('private UI failure'); } }, collector, 'private'), true);
  const safe = JSON.parse(readFileSync(output, 'utf8')) as ElementApplyDiagnosticArtifact;
  assert.equal(safe.losses.ui, true);
  assert.equal(safe.lifecycle.testOutcome, 'unknown');
  const missing = join(directory, 'missing', 'diagnostic.json');
  const unwritable = new ElementApplyDiagnosticCollector();
  unwritable.recordApplyClick();
  assert.equal(await retainElementApplyDiagnostic({ outputPath: () => missing, async attach() { attaches += 1; } }, undefined, unwritable, 'failed'), false);
  assert.equal(existsSync(missing), false);
  assert.equal(attaches, 1);
});

test('no Apply produces no diagnostic file or attachment', async () => {
  const collector = new ElementApplyDiagnosticCollector();
  assert.equal(await retainElementApplyDiagnostic({ outputPath() { assert.fail('unexpected output'); }, async attach() { assert.fail('unexpected attachment'); } }, undefined, collector, 'passed'), false);
});
