import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { compileFunction } from 'node:vm';
import ts from 'typescript';

const source = readFileSync(new URL('./auto-real-proxy-helpers.ts', import.meta.url), 'utf8');
const observerSource = readFileSync(new URL('../three-products.spec.ts', import.meta.url), 'utf8');
const constants = source.match(/^export const (?:NATIVE_RUNTIME_COMMIT|TASK_API_POST|READ_ONLY_RUNTIME_POST|MEDIA_IMPORT_POST|LEGACY_POST) = [^;]+;/gm)
  ?.map((line) => line.replace(/^export /, ''));
assert.equal(constants?.length, 5, 'traffic classifier constants must remain source-visible');
const helper = source.match(/^export function classifyRuntimePost\([^]*?^}/m)?.[0];
assert.ok(helper, 'traffic classifier helper must remain source-visible');
const classifyRuntimePost = compileFunction(
  `${constants.join('\n')}\n${ts.transpileModule(helper.replace(/^export /, ''), {}).outputText}\nreturn classifyRuntimePost;`,
  [],
)();

const inverseHelpers = source.match(/^export function normalRuntimeCommitPath\([^]*?^}\n\nexport interface RuntimeRequestLike[^]*?^}\n\nexport function isExpectedInverseRequest\([^]*?^}/m)?.[0];
assert.ok(inverseHelpers, 'inverse request matcher must remain source-visible');
const isExpectedInverseRequest = compileFunction(
  `${ts.transpileModule(inverseHelpers.replaceAll(/^export /gm, ''), {}).outputText}\nreturn isExpectedInverseRequest;`,
  [],
)();

const headHelper = source.match(/^export function requireAuthoritativeHead\([^]*?^}/m)?.[0];
assert.ok(headHelper, 'authoritative head helper must remain source-visible');
const requireAuthoritativeHead = compileFunction(
  `${ts.transpileModule(headHelper.replace(/^export /, ''), {}).outputText}\nreturn requireAuthoritativeHead;`,
  [],
)();

const evidenceHelpers = source.match(/^export const EVIDENCE_METHODS[^]*?^export function relevantEvidenceRoute\([^]*?^}/m)?.[0];
assert.ok(evidenceHelpers, 'allowlisted evidence helpers must remain source-visible');
const evidence = compileFunction(
  `${ts.transpileModule(evidenceHelpers.replace(/^export /gm, ''), {}).outputText}\nreturn { allowlistedEvidenceMethod, allowlistedEvidenceStatus, relevantEvidenceRoute };`,
  [],
)();

function request(url, method, body) {
  return { method: () => method, url: () => url, postDataJSON: () => body };
}

const projectId = 'project-control';
const timelineId = 'timeline-control';
const publicationId = 'publication-control';
const commitPath = `/api/runtime/v1/projects/${projectId}/timelines/${timelineId}/commit`;
const inverseBody = {
  api_version: 1,
  project_id: projectId,
  timeline_id: timelineId,
  base_revision_id: 'revision-control',
  base_publication_id: 'publication-base-control',
  commands: [{
    schema_version: 1,
    op: 'timeline.inverse',
    version: '1',
    select: null,
    args: { publications: [publicationId] },
  }],
  source: { via: 'app' },
};

test('pure: exact native inverse matcher keeps positive and negative controls', () => {
  assert.equal(isExpectedInverseRequest(request(`https://app.test${commitPath}`, 'POST', inverseBody), projectId, timelineId, publicationId), true);
  for (const [label, candidate] of [
    ['wrong method', request(`https://app.test${commitPath}`, 'GET', inverseBody)],
    ['wrong path scope', request(`https://app.test/api/runtime/v1/projects/other/timelines/${timelineId}/commit`, 'POST', inverseBody)],
    ['wrong body project', request(`https://app.test${commitPath}`, 'POST', { ...inverseBody, project_id: 'other' })],
    ['wrong body timeline', request(`https://app.test${commitPath}`, 'POST', { ...inverseBody, timeline_id: 'other' })],
    ['operation-route lookalike', request(`https://app.test/runtime-config/v1/operation/runtime/v1/projects/${projectId}/timelines/${timelineId}/commit`, 'POST', inverseBody)],
    ['query lookalike', request(`https://app.test${commitPath}?lookalike=1`, 'POST', inverseBody)],
    ['empty base pin', request(`https://app.test${commitPath}`, 'POST', { ...inverseBody, base_revision_id: '' })],
    ['wrong publication', request(`https://app.test${commitPath}`, 'POST', { ...inverseBody, commands: [{ ...inverseBody.commands[0], args: { publications: ['other'] } }] })],
    ['two inverse commands', request(`https://app.test${commitPath}`, 'POST', { ...inverseBody, commands: [inverseBody.commands[0], inverseBody.commands[0]] })],
    ['extra body field', request(`https://app.test${commitPath}`, 'POST', { ...inverseBody, extra: true })],
    ['legacy publish route', request('https://app.test/api/runtime/v1/projects/p/timelines/t/composition-revisions/publish', 'POST', inverseBody)],
  ]) assert.equal(isExpectedInverseRequest(candidate, projectId, timelineId, publicationId), false, label);
});

test('pure: traffic controls classify native, task, read-only, and retired paths explicitly', () => {
  const nativeCommit = '/api/runtime/v1/projects/p/timelines/t/commit';
  assert.equal(classifyRuntimePost('POST', nativeCommit), 'native-commit');
  for (const path of ['/api/runtime/v1/tasks', '/api/runtime/v1/tasks/task-1/cancel', '/api/runtime/v1/tasks/task-1/retry', '/api/runtime/v1/managed-outputs/output-1/export']) {
    assert.equal(classifyRuntimePost('POST', path), 'task-api', path);
  }
  for (const path of ['/api/runtime/v1/handshake', '/api/runtime/v1/projects/p/timelines/t/inspect']) {
    assert.equal(classifyRuntimePost('POST', path), 'read-only', path);
  }
  for (const path of ['/api/runtime/v1/projects/p/timelines/t/composition-revisions', '/api/runtime/v1/projects/p/timelines/t/composition-revisions/publish', '/api/runtime/v1/proxiedv1/projects/p/timelines/t/composition-revisions']) {
    assert.equal(classifyRuntimePost('POST', path), 'legacy-writer', path);
  }
  for (const [method, path, expected] of [
    ['GET', nativeCommit, 'other'], ['GET', '/api/runtime/v1/handshake', 'other'], ['PUT', '/api/runtime/v1/handshake', 'other'],
    ['POST', '/api/runtime/v1/handshake/', 'legacy-writer'], ['POST', '/api/runtime/v1/projects/p/timelines/t/inspect/', 'legacy-writer'],
    ['POST', `${nativeCommit}/extra`, 'legacy-writer'], ['POST', '/api/astrid/v1/projects/p/timelines/t/composition-revisions', 'other'],
  ]) assert.equal(classifyRuntimePost(method, path), expected, `${method} ${path}`);
});

test('pure: all mutation methods classify the legacy route without admitting reads or kept catalog operations', () => {
  const legacyPath = '/api/runtime/v1/projects/p/timelines/t/composition-revisions';
  for (const method of ['POST', 'PUT', 'PATCH', 'DELETE']) {
    assert.equal(classifyRuntimePost(method, legacyPath), 'legacy-writer', `${method} ${legacyPath}`);
  }
  for (const [method, path, expected] of [
    ['GET', legacyPath, 'other'],
    ['POST', '/api/runtime/v1/projects/p/timelines/t/commit', 'native-commit'],
    ['GET', '/api/astrid/v1/capabilities', 'other'],
  ]) {
    assert.equal(classifyRuntimePost(method, path), expected, `${method} ${path}`);
  }
});

test('pure: only the exact generated media-import POST is kept catalog traffic', () => {
  const mediaImportPath = '/api/runtime/v1/projects/p/media-imports';
  assert.equal(classifyRuntimePost('POST', mediaImportPath), 'other');
  for (const [method, expected] of [['GET', 'other'], ['PUT', 'legacy-writer'], ['PATCH', 'legacy-writer'], ['DELETE', 'legacy-writer']]) {
    assert.equal(classifyRuntimePost(method, mediaImportPath), expected, `${method} ${mediaImportPath}`);
  }
  for (const path of [
    `${mediaImportPath}/`,
    `${mediaImportPath}/operation-1`,
    '/api/runtime/v1/projects/p/media-imports-extra',
    '/api/runtime/v1/projects/p/timelines/t/media-imports',
  ]) {
    assert.equal(classifyRuntimePost('POST', path), 'legacy-writer', `POST ${path}`);
  }
  for (const path of [
    '/api/runtime/v1/projects/p/timelines/t/composition-revisions',
    '/api/runtime/v1/projects/p/timelines/t/composition-revisions/publish',
    '/api/runtime/v1/proxiedv1/projects/p/timelines/t/composition-revisions',
  ]) {
    for (const method of ['POST', 'PUT', 'PATCH', 'DELETE']) {
      assert.equal(classifyRuntimePost(method, path), 'legacy-writer', `${method} ${path}`);
    }
  }
});

test('pure: authoritative head uses the Runtime pair and refuses incomplete values', () => {
  assert.deepEqual(requireAuthoritativeHead({ head: { revision_id: 'reused-older-head', publication_id: 'reused-head-publication' } }), {
    revision_id: 'reused-older-head', publication_id: 'reused-head-publication',
  });
  for (const body of [{}, { head: null }, { head: { revision_id: 'revision-only' } }, { head: { publication_id: 'publication-only' } }]) {
    assert.throws(() => requireAuthoritativeHead(body), /authoritative head pair/);
  }
});

test('pure: planted Runtime 503 retains only allowlisted route, method and status facts', () => {
  const route = evidence.relevantEvidenceRoute('https://app.test/runtime-config/v1/operation/runtime/v1/tasks?credential=secret&bearer=token&cookie=session');
  assert.equal(route, 'runtime-operation');
  const record = {
    method: evidence.allowlistedEvidenceMethod('GET'),
    route,
    status: evidence.allowlistedEvidenceStatus(503),
  };
  assert.deepEqual(record, {
    method: 'GET', route: 'runtime-operation', status: 503,
  });
  assert.equal(JSON.stringify(record).includes('secret'), false);
  assert.equal(JSON.stringify(record).includes('token'), false);
  assert.equal(JSON.stringify(record).includes('session'), false);
});

test('pure: planted private path and non-Bearer or oversized text are not retained', () => {
  const privatePath = 'https://app.test/runtime-config/v1/operation/runtime/v1/tasks/privatepath/secret-file';
  const privateRecord = { route: evidence.relevantEvidenceRoute(privatePath) };
  assert.equal(privateRecord.route, 'runtime-operation');
  assert.equal(JSON.stringify(privateRecord).includes('privatepath'), false);
  assert.equal(evidence.relevantEvidenceRoute('https://app.test/privatepath/secret-file'), undefined);
  assert.equal(evidence.allowlistedEvidenceMethod('GET secret-token'), undefined);
  assert.equal(evidence.allowlistedEvidenceStatus(600), undefined);
  const oversizedText = 'oversized-text-'.repeat(200);
  const record = {
    method: evidence.allowlistedEvidenceMethod('GET'),
    route: evidence.relevantEvidenceRoute(`https://app.test/api/runtime/v1/events?query=nonBearer-secret&message=${oversizedText}`),
    status: evidence.allowlistedEvidenceStatus(503),
  };
  assert.deepEqual(record, { method: 'GET', route: 'runtime-api', status: 503 });
  assert.equal(JSON.stringify(record).includes('nonBearer-secret'), false);
  assert.equal(JSON.stringify(record).includes(oversizedText), false);
  const observer = observerSource.match(/function captureBoundedBrowserEvidence\([^]*?^}/m)?.[0];
  assert.ok(observer, 'bounded browser observer must remain source-visible');
  assert.doesNotMatch(observer, /response\.(?:text|body)\(\)/, 'observer must not buffer response bodies');
  assert.doesNotMatch(observer, /message\.text\(\)|error\.message/, 'observer must not retain free-form diagnostics');
  assert.doesNotMatch(source, /boundedEvidenceText|summarizeEvidenceBody|message|error\.message/);
});
