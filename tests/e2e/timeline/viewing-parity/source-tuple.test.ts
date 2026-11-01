import assert from 'node:assert/strict';
import { test } from 'node:test';
import { assertFrameSourceTuple, PEER_FILES, type FrameSourceTuple } from './source-tuple';
import { assertSourceVersionsUnchanged } from './harness';
import { playerBrowserProfile } from './browser-profile';

// Synthetic validator input only; never selects an installed graph or authorizes a run.
function tuple(): FrameSourceTuple {
  const source = { root: '/synthetic', commit: 'a'.repeat(40), tree: 'b'.repeat(40) };
  const digest = `sha256:${'c'.repeat(64)}`;
  return { schema: 'timeline.viewing.next-five-case/v1', frozen: true,
    sources: { app: { ...source }, agent: { ...source }, runtime: { ...source }, composition: { ...source } },
    appSource: { files: 1, sha256: digest }, remotionProject: '/synthetic/remotion',
    peers: { app: Object.fromEntries(PEER_FILES.map(path => [path, digest])),
      agent: Object.fromEntries(PEER_FILES.map(path => [path, digest])) },
    client: { official: true, producerCommit: 'd'.repeat(40), producerTree: 'e'.repeat(40),
      producerVersion: digest, artifactCount: 75, files: { 'src/integrations/runtime/generated.ts': digest } } };
}

test('accepts a complete source contract without discovering installed pins', () => {
  assertFrameSourceTuple(tuple());
});

test('refuses owner-pending sources, peers, official client, and content freeze', () => {
  assert.throws(() => assertFrameSourceTuple(undefined), /owner-pending/);
  for (const mutate of [
    (p: FrameSourceTuple) => { p.frozen = false as true; },
    (p: FrameSourceTuple) => { p.sources.app.commit = '667498cc'; },
    (p: FrameSourceTuple) => { p.appSource.files = 0; },
    (p: FrameSourceTuple) => { p.peers.app = {}; },
    (p: FrameSourceTuple) => { delete p.peers.agent[PEER_FILES[0]]; },
    (p: FrameSourceTuple) => { p.peers.app['node_modules/other'] = p.peers.app[PEER_FILES[0]]; },
    (p: FrameSourceTuple) => { p.peers.app[PEER_FILES[0]] = 'learned-from-install'; },
    (p: FrameSourceTuple) => { p.client.official = false as true; },
    (p: FrameSourceTuple) => { p.client.producerCommit = 'not-a-sha'; },
    (p: FrameSourceTuple) => { p.client.producerTree = 'not-a-sha'; },
    (p: FrameSourceTuple) => { p.client.producerVersion = 'not-a-digest'; },
    (p: FrameSourceTuple) => { p.client.artifactCount = 0; },
    (p: FrameSourceTuple) => { p.client.files = {}; },
    (p: FrameSourceTuple) => { p.client.files['../outside'] = p.peers.app[PEER_FILES[0]]; },
  ]) {
    const invalid = tuple(); mutate(invalid);
    assert.throws(() => assertFrameSourceTuple(invalid));
  }
});

test('postflight rejects source identity and source tuple changes after a failed or successful case', () => {
  const before = { compositionFiles: {}, renderGraphHashes: {}, playerBrowser: playerBrowserProfile(),
    exportBrowserHash: 'export', sourceState: { app: { ino: 1 } }, sourceTupleHash: 'tuple' };
  for (const after of [
    { ...before, sourceState: { app: { ino: 2 } } },
    { ...before, sourceTupleHash: 'changed' },
  ]) assert.throws(() => assertSourceVersionsUnchanged(before, after), /source dependency graph changed/);
});
