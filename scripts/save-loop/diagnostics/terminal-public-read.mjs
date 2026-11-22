import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {readFile, writeFile} from 'node:fs/promises';
import path from 'node:path';
import {isDeepStrictEqual} from 'node:util';

import {publicSnapshot} from '../assert.mjs';
import {runtimeRootForData} from '../cpu.mjs';
import {expectedFixtureIds, sameIds} from '../readiness.mjs';

function canonicalPayloadJson(value) {
  if (Array.isArray(value)) return `[${value.map(canonicalPayloadJson).join(',')}]`;
  if (value !== null && typeof value === 'object') {
    const entries = Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${canonicalPayloadJson(value[key])}`);
    return `{${entries.join(',')}}`;
  }
  return Object.is(value, -0) ? '-0' : JSON.stringify(value);
}

function compareFreeSpacePayload(snapshot, records) {
  const document = records.find(row => row.type === 'free_space_document');
  if (!document) return null;
  const fingerprint = document.normalized_payload_fingerprint;
  assert(fingerprint?.algorithm === 'sha256/canonical-json-v1' && fingerprint.at_sentinel === 'p77-free-space:selected-at');
  const normalized = structuredClone(snapshot.payload);
  const {config, clips: mirror} = normalized;
  assert(Array.isArray(config?.clips) && (mirror === undefined || isDeepStrictEqual(mirror, config.clips)));
  let actual;
  for (const clips of mirror === undefined ? [config.clips] : [config.clips, mirror]) {
    const [clip, duplicate] = clips.filter(item => item?.id === document.target.clip_id);
    assert(clip && !duplicate && clip.track === document.target.track_id && Number.isFinite(clip.at));
    actual = clip.at;
    clip.at = fingerprint.at_sentinel;
  }
  const normalizedSha = createHash('sha256').update(canonicalPayloadJson(normalized), 'utf8').digest('hex');
  const summary = records.find(row => row.type === 'summary');
  const [commit, extra] = summary.commits;
  const receipt = commit?.receipt;
  const receiptMatches = Boolean(!extra && commit?.exactCas && commit.exactAcceptedCas && receipt?.status === 'accepted' &&
    receipt.revision === snapshot.headRevision && receipt.publication === snapshot.publicationId &&
    receipt.content_digest === snapshot.content_digest);
  const geometry = summary.free_space?.geometry;
  const end = actual + document.span.duration_seconds;
  const inFreeInterval = Boolean(geometry && actual > document.span.start_seconds &&
    document.siblings.every(row => row.end_seconds <= actual) && end < geometry.visible_time_bounds_seconds[1] &&
    Math.abs(actual - geometry.desired_start_seconds) <= 2 / geometry.pixels_per_second + 0.002);
  const event = predicate => records.find(row => row.type === 'event' && row.at >= summary.pointerup_ms && predicate(row));
  const sent = event(row => row.phase === 'fetch-request' && row.endpoint === 'timeline_commit');
  const response = sent && event(row => row.phase === 'fetch-response' && row.endpoint === 'timeline_commit' &&
    row.request === sent.request && row.status >= 200 && row.status < 300);
  const saved = response && event(row => row.phase === 'badge' && row.state === 'saved' && row.at >= response.at);
  const payloadMatches = normalizedSha === fingerprint.sha256;
  const browserComplete = summary.failure === 'after_public_head' && summary.qualified_gesture && summary.omitted_events === 0 &&
    summary.free_space?.native_basis?.qualified && summary.native_stages?.authoritative_adoption === 'verified head and publication' &&
    summary.user_visible_state?.state === 'saved';
  const confirmed = Boolean(browserComplete && saved && receiptMatches && inFreeInterval && payloadMatches);
  return {target: document.target, original_start_seconds: document.span.start_seconds, actual_start_seconds: actual,
    normalized_after_sha256: normalizedSha, normalized_payload_matches: payloadMatches, receipt_matches: receiptMatches,
    actual_in_verified_interval: inFreeInterval, confirmed_by_combined_evidence: confirmed,
    ...(confirmed ? {gesture_to_post_ms: sent.at - summary.pointerup_ms, post_to_response_ms: response.at - sent.at,
      response_to_saved_ms: saved.at - response.at, gesture_to_saved_ms: saved.at - summary.pointerup_ms} : {}),
  };
}

const [root, manifest, output] = process.argv.slice(2);
assert(root && manifest === path.join(root, 'results/manifest.json'));
assert.equal(output, path.join(root, 'results/terminal-public-postflight.json'));
assert.equal(await readFile(path.join(root, '.sl1-stack-owned'), 'utf8'), `astrid-app-sl1-stack-v1 ${root}`);
const fixture = JSON.parse(await readFile(manifest, 'utf8'));
assert(fixture.media.synthetic && fixture.live_proof.restored_version === 30 && fixture.measurement.clip_count === 300);
const origin = 'http://127.0.0.1:2400';
const data = path.join(root, 'direct-data');
const health = origin + '/api/runtime/v1/health';
const runtime = await runtimeRootForData(root, data, health);
const scope = `/api/runtime/v1/projects/${encodeURIComponent(fixture.project_id)}/timelines/${encodeURIComponent(fixture.timeline_id)}`;
const fetchNative = globalThis.fetch;
let snapshot, failed;
try {
  globalThis.fetch = (input, init) => {
    const url = new URL(input);
    assert.equal(url.origin, origin);
    assert(init?.method === 'GET' && (url.pathname === scope || url.pathname.startsWith(`${scope}/composition-revisions`)));
    return fetchNative(url, {...init, redirect: 'error', signal: AbortSignal.timeout(65000)});
  };
  // The installed harness supplies the metadata, revision and index validation.
  // Its callbacks use browser-compatible public APIs that Node also provides.
  snapshot = await publicSnapshot({evaluate: (read, ...args) => read(...args)}, origin, fixture);
} catch (error) {
  failed = error.name === 'TimeoutError' ? 'deadline' : 'public_snapshot_failed';
} finally {
  globalThis.fetch = fetchNative;
}
assert.deepEqual(await runtimeRootForData(root, data, health), runtime);
const occurrences = fixture.clips.shot_occurrences.map(item => item.occurrence_id);
const unchanged = snapshot && snapshot.headRevision === fixture.live_proof.restored_revision &&
  snapshot.publicationId === fixture.live_proof.restored_publication &&
  snapshot.content_digest === fixture.live_proof.restored_content_digest;
let freeSpace;
if (snapshot) {
  try {
    const raw = await readFile(path.join(root, 'results/results.jsonl'), 'utf8');
    freeSpace = compareFreeSpacePayload(snapshot, raw.trim().split('\n').map(line => JSON.parse(line)));
  } catch { freeSpace = {status: 'unqualified'}; }
}
await writeFile(output, JSON.stringify({
  status: snapshot ? (unchanged ? 'verified_original_head' : 'verified_changed_head') : 'unavailable',
  failed: failed ?? null,
  runtime,
  after: snapshot ? {revision: snapshot.headRevision, publication: snapshot.publicationId,
    content_digest: snapshot.content_digest, payload_digest: snapshot.payload_digest,
    active_heads: snapshot.headCount, clips_match: sameIds(snapshot.clipIds, expectedFixtureIds(fixture)),
    occurrences_match: sameIds((snapshot.payload.occurrences ?? []).map(item => item.occurrence_id), occurrences)} : null,
  free_space: freeSpace ?? null,
  scope: 'Independent postflight through the same authenticated public App proxy after the measured browser closed.',
}, null, 2) + '\n', {flag: 'wx', mode: 0o600});
