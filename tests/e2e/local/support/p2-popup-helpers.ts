import { execFileSync } from 'node:child_process';
import { expect, type Request } from '@playwright/test';
import type {
  CanonicalDocument,
  CommitAcceptedMutation,
  HeadPin,
  HistoryEntry,
} from '../../../../src/integrations/runtime/timeline-commit-types.ts';

type JsonObject = Record<string, unknown>;

declare const ASTRID_PYTHON: string;
declare const RUNTIME_CHECKOUT: string;

function isReadOnlyInspection(request: Request): boolean {
  const url = new URL(request.url());
  return request.method() === 'POST'
    && /^\/(?:api\/runtime\/)?v1\/projects\/[^/]+\/timelines\/[^/]+\/inspect$/.test(url.pathname)
    && url.search === '' && url.hash === '';
}

function authoritativeParentHashes(expected: CanonicalDocument, beforeRaw: string): { contentDigest: string; revisionId: string } {
  const script = [
    'import json, sys',
    'sys.path.insert(0, sys.argv[1])',
    'from runtime_protocol.timeline_commit_validation import digest',
    'value = json.load(sys.stdin)',
    'expected = value["expected"]',
    'source = json.loads(value["before"])',
    'def restore(value, source):',
    '    if isinstance(source, float) and isinstance(value, (int, float)) and value == source: return float(value)',
    '    if isinstance(value, dict) and isinstance(source, dict): return {key: restore(item, source[key]) if key in source else item for key, item in value.items()}',
    '    if isinstance(value, list) and isinstance(source, list): return [restore(item, source[index]) if index < len(source) else item for index, item in enumerate(value)]',
    '    return value',
    'payload = restore(expected["payload"], source["payload"])',
    'manifest = restore(expected["manifest"], source["dependency_manifest"])',
    'content_digest = digest(payload)',
    'revision_id = "authoring-parent-revision-" + digest({"project_id": expected["project_id"], "timeline_id": expected["timeline_id"], "parent": payload, "manifest": manifest})[7:]',
    'print(json.dumps({"contentDigest": content_digest, "revisionId": revision_id}))',
  ].join('\n');
  return JSON.parse(execFileSync(ASTRID_PYTHON, ['-c', script, RUNTIME_CHECKOUT], {
    input: JSON.stringify({ expected: {
      project_id: expected.project_id,
      timeline_id: expected.timeline_id,
      payload: expected.parent_revision.payload,
      manifest: expected.dependency_manifest,
    }, before: beforeRaw }),
    encoding: 'utf8', env: { ...process.env, PYTHONDONTWRITEBYTECODE: '1' }, timeout: 30_000,
  }).trim()) as { contentDigest: string; revisionId: string };
}

function authoritativePublicationId(post: { key: string }, result: CommitAcceptedMutation): string {
  expect(result.receipt.idempotency_key).toBe(post.key);
  expect(result.receipt.receipt_id).toEqual(expect.stringMatching(/^txn-\S+$/));
  expect(result.receipt.receipt_id).not.toBe(post.key);
  return result.receipt.receipt_id;
}

function assertAuthoritativeHistoryPublication(entry: HistoryEntry, result: CommitAcceptedMutation): void {
  expect(entry.publication_id).toBe(result.receipt.receipt_id);
}

function assertAuthoritativeHead(head: HeadPin, result: CommitAcceptedMutation): void {
  expect(head).toEqual({
    revision_id: result.data.accepted_revision_id,
    publication_id: result.receipt.receipt_id,
  });
}

function assertInverseTargetsPublication(inverse: { body: { commands: unknown[] } }, publicationId: string): void {
  expect(inverse.body.commands).toEqual([{
    schema_version: 1, op: 'timeline.inverse', version: '1', select: null,
    args: { publications: [publicationId] },
  }]);
}

function assertUndoHistoryPublication(entry: HistoryEntry, publicationId: string): void {
  expect(entry.records?.undo_of).toEqual([publicationId]);
}

function expectedPopupCreatedClaims(
  beforeAssets: JsonObject, owner: string, op: 'occurrence.add-media' | 'occurrence.swap-media',
  asset: string, clipId: string,
): string[] {
  const created = Object.prototype.hasOwnProperty.call(beforeAssets, asset) ? [] : [`${owner}/asset:${asset}`];
  return op === 'occurrence.add-media' ? [...created, `${owner}/clip:${clipId}`] : created;
}

export {
  isReadOnlyInspection,
  authoritativeParentHashes,
  authoritativePublicationId,
  assertAuthoritativeHistoryPublication,
  assertAuthoritativeHead,
  assertInverseTargetsPublication,
  assertUndoHistoryPublication,
  expectedPopupCreatedClaims,
};
