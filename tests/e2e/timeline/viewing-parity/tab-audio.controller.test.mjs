import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync, lstatSync, mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import {
  APP13, AGENT13, RUNTIME13, RUNTIME13_ARTIFACT, AGENT13_RUNTIME, COMPOSITION13, CHROME155, CONTROL, NODE20,
  VIEWING_QUALIFICATIONS,
  MISSING_OWNER_PORTS, OWNER_PORTS,
  assertAppOwnerBase, assertAppOwnLeaf, assertCandidateTuple, assertFrozenRuntimeGraph, assertNode20, assertOwnedShortTemp, assertOwnerPorts,
  assertExactGraph, assertRuntimeArtifact, readAppSourceSelection,
} from './tab-audio.controller.mjs';

const CURRENT_APP_SOURCE = '20ea14c26526fe4924354f10a177aebbaf6002bc';
const CURRENT_APP_TREE = '83cfad527f8b2264085571316cede1c6ae482b5f';

function git(root, args) {
  try {
    return execFileSync('git', ['-C', root, ...args], { encoding: 'utf8' }).trim();
  } catch (error) {
    if (error.status === 0 && typeof error.stdout === 'string') return error.stdout.trim();
    throw error;
  }
}

function initFixture(root, source, commit) {
  git(process.cwd(), ['init', '--quiet', root]);
  git(root, ['fetch', '--quiet', source, commit]);
  git(root, ['checkout', '--quiet', '--detach', commit]);
}

function createMinimalAppFixture(root) {
  git(process.cwd(), ['init', '--quiet', root]);
  const files = [
    'tests/e2e/timeline/viewing-parity/tab-audio.controller.mjs',
    'tests/e2e/timeline/viewing-parity/tab-audio.controller.test.mjs',
  ];
  for (const file of files) {
    const fixtureFile = path.join(root, file);
    mkdirSync(path.dirname(fixtureFile), { recursive: true });
    writeFileSync(fixtureFile, 'controller fixture owner base\n');
  }
  git(root, ['add', '--', ...files]);
  const baselineTree = git(root, ['write-tree']);
  const baseline = git(root, [
    '-c', 'user.name=Timeline Tests', '-c', 'user.email=timeline-tests@example.invalid',
    'commit-tree', baselineTree, '-m', 'test exact graph owner base',
  ]);
  git(root, ['update-ref', 'refs/heads/tl/integration', baseline]);

  for (const file of files) writeFileSync(path.join(root, file), 'controller fixture leaf\n');
  git(root, ['add', '--', ...files]);
  const fixtureTree = git(root, ['write-tree']);
  const fixtureCommit = git(root, [
    '-c', 'user.name=Timeline Tests', '-c', 'user.email=timeline-tests@example.invalid',
    'commit-tree', fixtureTree, '-p', baseline, '-m', 'test exact graph fixture',
  ]);
  git(root, ['update-ref', 'HEAD', fixtureCommit]);
  return { source: baseline, tree: baselineTree };
}

function createOwnedTempDirectory() {
  const privateTmpdir = realpathSync(tmpdir());
  const directory = mkdtempSync(path.join(privateTmpdir, 'timeline-controller-test-'));
  if (path.dirname(directory) !== privateTmpdir || path.resolve(directory) !== directory) {
    rmSync(directory, { recursive: true, force: true });
    throw new Error('controller fixture temp directory escaped the worker TMPDIR');
  }
  return { directory, privateTmpdir };
}

function removeOwnedTempDirectory({ directory, privateTmpdir }) {
  if (!existsSync(directory)) return;
  const directoryStat = lstatSync(directory);
  if (!directoryStat.isDirectory() || directoryStat.isSymbolicLink()) return;
  const realDirectory = realpathSync(directory);
  if (path.dirname(realDirectory) !== privateTmpdir || realDirectory !== directory) return;
  rmSync(directory, { recursive: true, force: true });
}

function createExactGraphFixtures({ afterDirectoryCreated } = {}) {
  const temp = createOwnedTempDirectory();
  const { directory } = temp;
  const appRoot = path.join(directory, 'app');
  const agentRoot = path.join(directory, 'agent');
  const runtimeRoot = path.join(directory, 'runtime');
  try {
    afterDirectoryCreated?.(directory);
    const app = createMinimalAppFixture(appRoot);

    for (const [root, source] of [[agentRoot, '/home/user/work/agent'], [runtimeRoot, '/home/user/work/runtime']]) {
      initFixture(root, source, source === '/home/user/work/agent' ? AGENT13.source : RUNTIME13.source);
    }
    return { ...temp, app, appRoot, agentRoot, runtimeRoot };
  } catch (error) {
    removeOwnedTempDirectory(temp);
    throw error;
  }
}

test('READY controller identifies the integrated App13 and verified normal13 tuple', () => {
  assertCandidateTuple({ app: APP13, agent: AGENT13, runtime: RUNTIME13, composition: COMPOSITION13 });
  assert.equal(APP13.source, 'ea38656fe62950440b36cafee780698cff2c3f9c');
  assert.equal(APP13.status, 'adopted');
  assert.equal(AGENT13.status, 'verified-runtime-freeze');
  assert.equal(RUNTIME13.status, 'qualified-viewing');
  assert.equal(RUNTIME13.ownerAck, 'acknowledged');
  assertRuntimeArtifact();
  assert.notEqual(RUNTIME13.source, RUNTIME13_ARTIFACT.source);
  assert.equal(AGENT13_RUNTIME.graphFileCount, 21455);
  assert.equal(CONTROL.physicalMixClaim, false);
  assert.equal(CONTROL.app13Consumer, 'adopted');
  assert.equal(CONTROL.ownLeafOnly, true);
  assert.equal(CONTROL.all77BytesPinned, true);
});
test('controller rejects a changed source tuple before capture', () => {
  assert.throws(() => assertCandidateTuple({ app: { ...APP13, tree: 'changed' }, agent: AGENT13, runtime: RUNTIME13, composition: COMPOSITION13 }), /app13 candidate tuple changed/);
  assert.throws(() => assertCandidateTuple({ app: APP13,
    agent: { ...AGENT13, source: '1111111111111111111111111111111111111111' }, runtime: RUNTIME13, composition: COMPOSITION13 }),
  /agent13 candidate tuple changed/);
  assert.throws(() => assertCandidateTuple({ app: APP13,
    agent: { ...AGENT13, tree: '2222222222222222222222222222222222222222' }, runtime: RUNTIME13, composition: COMPOSITION13 }),
  /agent13 candidate tuple changed/);
  assert.throws(() => assertCandidateTuple({ app: APP13, agent: AGENT13,
    runtime: { ...RUNTIME13, source: RUNTIME13_ARTIFACT.source, tree: RUNTIME13_ARTIFACT.tree }, composition: COMPOSITION13 }),
  /runtime13 candidate tuple changed/);
  assert.throws(() => assertCandidateTuple({ app: APP13, agent: AGENT13,
    runtime: { ...RUNTIME13, tree: '3333333333333333333333333333333333333333' }, composition: COMPOSITION13 }),
  /runtime13 candidate tuple changed/);
  assert.throws(() => assertCandidateTuple({ app: APP13, agent: AGENT13, runtime: RUNTIME13,
    composition: { ...COMPOSITION13, source: '4444444444444444444444444444444444444444' } }),
  /composition13 candidate changed/);
  assert.throws(() => assertCandidateTuple({ app: APP13, agent: AGENT13, runtime: RUNTIME13,
    composition: { ...COMPOSITION13, artifact: 'sha256-wrong' } }),
  /composition13 candidate changed/);
  assert.throws(() => assertRuntimeArtifact({ ...RUNTIME13_ARTIFACT, source: '5555555555555555555555555555555555555555' }), /artifact producer facts changed/);
  assert.throws(() => assertRuntimeArtifact({ ...RUNTIME13_ARTIFACT, tree: '6666666666666666666666666666666666666666' }), /artifact producer facts changed/);
  assert.throws(() => assertRuntimeArtifact({ ...RUNTIME13_ARTIFACT, version: 'sha256:wrong' }), /artifact producer facts changed/);
});

test('controller accepts an externally selected literal current App source/tree', () => {
  const app = readAppSourceSelection({
    TIMELINE_VIEWING_APP_SOURCE: '20ea14c26526fe4924354f10a177aebbaf6002bc',
    TIMELINE_VIEWING_APP_TREE: '83cfad527f8b2264085571316cede1c6ae482b5f',
  });
  assert.deepEqual(app, {
    source: '20ea14c26526fe4924354f10a177aebbaf6002bc',
    tree: '83cfad527f8b2264085571316cede1c6ae482b5f',
    status: 'externally-pinned',
  });
  assertCandidateTuple({ app, agent: AGENT13, runtime: RUNTIME13, composition: COMPOSITION13 }, app);
});

test('controller refuses an explicitly empty App source/tree selection', () => {
  assert.throws(() => readAppSourceSelection({
    TIMELINE_VIEWING_APP_SOURCE: '',
    TIMELINE_VIEWING_APP_TREE: '',
  }), /must be supplied together/);
});

test('controller refuses an explicitly whitespace-only App source/tree selection', () => {
  assert.throws(() => readAppSourceSelection({
    TIMELINE_VIEWING_APP_SOURCE: '   ',
    TIMELINE_VIEWING_APP_TREE: '\t\n',
  }), /must be supplied together/);
});

test('controller refuses an externally selected mismatched App source', () => {
  const app = readAppSourceSelection({
    TIMELINE_VIEWING_APP_SOURCE: '20ea14c26526fe4924354f10a177aebbaf6002bc',
    TIMELINE_VIEWING_APP_TREE: '83cfad527f8b2264085571316cede1c6ae482b5f',
  });
  assert.throws(() => assertCandidateTuple({
    app: { ...app, source: '1111111111111111111111111111111111111111' },
    agent: AGENT13,
    runtime: RUNTIME13,
    composition: COMPOSITION13,
  }, app), /app13 candidate tuple changed/);
});

test('leaf refuses a candidate that self-selects as its owner base', () => {
  assert.throws(() => assertAppOwnLeaf(process.cwd(), '05de08cecabeaea2d0d955475e6190acc685111a'),
    /not an actual App integration ancestor/);
});

test('exact graph rejects a supplied App tree mismatch before leaf diff validation', () => {
  const fixtures = createExactGraphFixtures();
  try {
    assert.throws(() => assertExactGraph({
      appRoot: fixtures.appRoot,
      agentRoot: fixtures.agentRoot,
      runtimeRoot: fixtures.runtimeRoot,
      app: { source: fixtures.app.source, tree: `${fixtures.app.tree.slice(0, -1)}${fixtures.app.tree.endsWith('0') ? '1' : '0'}` },
    }), /selected App source\/tree does not name the selected commit/);
  } finally {
    removeOwnedTempDirectory(fixtures);
  }
  assert.equal(existsSync(fixtures.directory), false);

  let failedDirectory;
  assert.throws(() => createExactGraphFixtures({
    afterDirectoryCreated(directory) {
      failedDirectory = directory;
      throw new Error('forced fixture setup failure');
    },
  }), /forced fixture setup failure/);
  assert.equal(path.dirname(failedDirectory), realpathSync(tmpdir()));
  assert.equal(existsSync(failedDirectory), false);
});

test('leaf accepts the actual current App owner base lineage and tree', () => {
  assert.deepEqual(assertAppOwnerBase(process.cwd(), {
    source: CURRENT_APP_SOURCE,
    tree: CURRENT_APP_TREE,
  }), {
    source: CURRENT_APP_SOURCE,
    tree: CURRENT_APP_TREE,
  });
});

test('immutable d0 Runtime graph retains its lock, whole graph, and six peers', () => {
  const result = assertFrozenRuntimeGraph();
  assert.equal(result.lock, AGENT13_RUNTIME.lock);
  assert.equal(result.graph.sha256, AGENT13_RUNTIME.graph);
  assert.equal(result.graph.fileCount, AGENT13_RUNTIME.graphFileCount);
  assert.equal(result.artifact, COMPOSITION13.artifact);
  assert.equal(result.regularMembers, COMPOSITION13.regularMembers);
  assert.deepEqual(Object.keys(result.peers).sort(), Object.keys(AGENT13_RUNTIME.peers).sort());
});

test('readiness reports the current flat owner-port status', () => {
  assert.deepEqual(MISSING_OWNER_PORTS, []);
  assert.equal(OWNER_PORTS.find(({ port }) => port === 'complete-cap-current-join')?.source, 'a8283307a7a5537a95988031b385ef28df7524ea');
  assert.equal(OWNER_PORTS.find(({ port }) => port === 'native-frame-fixture')?.source, 'f084855eff0c40a464a166297d43536458ee4ca4');
  assert.equal(OWNER_PORTS.find(({ port }) => port === 'player-tab-audio-instrument')?.source, '379c19509ddb4f100d192c0e52d1307abc3c7a00');
  assert.equal(OWNER_PORTS.find(({ port }) => port === 'public13-normal-pin')?.source, AGENT13.source);
  assert.equal(OWNER_PORTS.some(({ port }) => port === 'track-inspector-preservation'), true);
  assert.deepEqual(assertOwnerPorts(), OWNER_PORTS);
});

test('one-root host catalog is a Viewing-owned qualification with source and test evidence', () => {
  assert.deepEqual(VIEWING_QUALIFICATIONS, [{
    owner: 'Viewing',
    port: 'public13-one-root-host-catalog',
    status: 'qualified',
    source: RUNTIME13.source,
    tree: RUNTIME13.tree,
    sourceTuple: {
      agent: { source: AGENT13.source, tree: AGENT13.tree },
      runtime: { source: RUNTIME13.source, tree: RUNTIME13.tree },
    },
    evidence: {
      central: { test: 'central14650', result: 'PASS', passed: 1 },
      oneRootHost: { test: 'one-root-host', result: 'PASS', passed: 1, duration: '44.14s' },
    },
  }]);
  assert.equal(OWNER_PORTS.some(({ port }) => port === 'public13-one-root-host-catalog'), false);
});

test('integrated App13 source remains a separate source guard', () => {
  assert.equal(APP13.status, 'adopted');
  assert.equal(APP13.source, 'ea38656fe62950440b36cafee780698cff2c3f9c');
  assert.equal(APP13.tree, '8bd8f741f7c8b28b8682aa960a658417f70c8522');
});

test('Chrome155 identity uses the complete executable and tree pins', () => {
  assert.match(CHROME155.sha256, /^[a-f0-9]{64}$/);
  assert.equal(CHROME155.treeSha256, '5b9b48fad617dc414d4a18ccfe9c7933c7bc4a8efd78c70d4f7a9e853808de0e');
  assert.equal(CHROME155.treeFileCount, 255);
});

test('Node identity rejects an unqualified executable', () => {
  assert.throws(() => assertNode20('/opt/node22/bin/node'), /selected Node must be v20\.19\.4/);
  assert.equal(NODE20.version, 'v20.19.4');
  assert.match(NODE20.sha256, /^[a-f0-9]{64}$/);
});

test('Node identity accepts the retained admitted executable and full hash', () => {
  assert.deepEqual(assertNode20(NODE20.executable), {
    version: NODE20.version,
    executable: NODE20.executable,
    sha256: NODE20.sha256,
  });
});

test('short owned temp calibration leaves no directory behind', () => {
  const directory = assertOwnedShortTemp();
  assert.equal(directory.startsWith('/tmp/timeline-tab-audio-'), true);
});
