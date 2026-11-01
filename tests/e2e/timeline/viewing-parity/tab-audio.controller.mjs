import { createHash } from 'node:crypto';
import { execFileSync, spawnSync } from 'node:child_process';
import { closeSync, lstatSync, mkdtempSync, openSync, readFileSync, readlinkSync, readdirSync, realpathSync, rmSync, statfsSync, statSync } from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { gunzipSync } from 'node:zlib';

export const APP13 = Object.freeze({
  source: 'ea38656fe62950440b36cafee780698cff2c3f9c',
  tree: '8bd8f741f7c8b28b8682aa960a658417f70c8522',
  status: 'adopted',
});
export const AGENT13 = Object.freeze({
  source: 'd0a5072bbe7b7ce9489f43aa0a81027ec400343b',
  tree: '6adb4a1190dfb2874e101565f37eccd392b1ae2f',
  status: 'verified-runtime-freeze',
});
export const RUNTIME13 = Object.freeze({
  source: '8f105c26e3b62f9c2683f717a9773a12bc775a8e',
  tree: 'b7f456d5135cba6049980ebc43a91c7a72ab8f7e',
  status: 'qualified-viewing',
  ownerAck: 'acknowledged',
});
export const RUNTIME13_ARTIFACT = Object.freeze({
  producer: 'astrid-runtime',
  source: '2c4ac180c2220bdad966bc01e95ad230e99ce26a',
  tree: '7ab412cc4bcbe517efcfa806e092336390312e18',
  version: 'sha256:6f000bc615a9cb24fb00cc69a97af75eae71006ebfe87e3caa272fcdbbb1af56',
  schema: 'sha256:8de823011a121359b9ad021e283b45afb6baeabc8a154a02bd086d1260a8b8f4',
  componentManifest: 'sha256:1ad76db27c1d9716bb234f811bf63e1f5898cb3d5f9b835a821765e6cad895e5',
  artifactCount: 75,
});
export const AGENT13_RUNTIME = Object.freeze({
  project: '/home/user/work/runtimes/agent-remotion-viewing13-d0a5072b',
  lock: 'c4d7030bd5418d35f2246269b5aba7952d0ed69ccd0084815a0043dfbb7a4e24',
  graph: '4913a37e5403c8372a283dcca8fd30c846b636abd88f59cfc572809d2fd0bd3c',
  graphFileCount: 21455,
  node: 'v20.19.4',
  npm: '10.8.2',
  composition: RUNTIME13_ARTIFACT,
  peers: Object.freeze({
    'node_modules/remotion/dist/cjs/audio/shared-audio-tags.js': '471b33916a91f5b9529c477bdf0ec586cb700d5a7179ab910a82dd932e172f6c',
    'node_modules/remotion/dist/esm/index.mjs': '9fdfe58f3f34e6a72564a811ac5d374d1c97a0f535e2a0e3aac198670d9b7ff8',
    'node_modules/@remotion/player/dist/cjs/use-player-methods.js': 'ff50ab8b4ae86423fab18aa1ecf6c48c41501c4f7b527f05a55c2c36598def46',
    'node_modules/@remotion/player/dist/esm/index.mjs': 'd3ef9728584c78e0e01cdb71ad72e3c6ddb36f96bfef90a4231d8b795e906b12',
    'node_modules/@remotion/player/dist/cjs/use-playback.js': '6c8369a19d7a29eab5dab4642799172d4f2a7e11dad39125edcb673ec5729fb0',
    'node_modules/@remotion/player/dist/cjs/PlayerUI.js': '5dc9b4b89310609f57a718c641334d530b72ecf284fc1682610afcec208a4fbb',
  }),
});
export const COMPOSITION13 = Object.freeze({
  source: '5a4e9b72f1916c4da01fa370ec5fe8d46b6da8e8',
  artifact: '9412ae25c306d5118241f4d631e8eecc6eef9b2fb5a98302d40938e9f6d54738',
  regularMembers: 77,
});
export const CHROME155 = Object.freeze({
  version: '155.0.8059.84',
  packageVersion: '155.0.8059.84-1',
  executable: '/opt/google/chrome/chrome',
  sha256: 'cb19b59995072b86cc7f887b3b1c7ab1f63518a7f2ed9f0d33249e1a040e2c76',
  treeSha256: '5b9b48fad617dc414d4a18ccfe9c7933c7bc4a8efd78c70d4f7a9e853808de0e',
  treeFileCount: 255,
});
export const NODE20 = Object.freeze({
  version: 'v20.19.4',
  executable: process.env.ASTRID_NODE_EXECUTABLE
    ?? '/tmp/claude-0/-home-user-repo/7dc61be1-7066-52e0-a5d0-94f90e61430a/scratchpad/orch/workers/vw-m3-current-root-cap-three-stills-prep/node',
  sha256: '43d6cf63f2a460b463eba6b19df5e9a259771c56f11b5130e04178a15bb99490',
});
export const MIN_FREE_BYTES = 10 * 1024 ** 3;
export const SHORT_TEMP_PREFIX = 'timeline-tab-audio-';
export const APP_SOURCE_ENV = 'TIMELINE_VIEWING_APP_SOURCE';
export const APP_TREE_ENV = 'TIMELINE_VIEWING_APP_TREE';
const APP_OWNER_INTEGRATION_REF = 'refs/heads/tl/integration';

const FULL_SHA = /^[a-f0-9]{40}$/;

export const CONTROL = Object.freeze({
  ownLeafOnly: true,
  wholeGraphPinned: true,
  all77BytesPinned: true,
  browserAndNodePinned: true,
  failClosedBeforeCapture: true,
  physicalMixClaim: false,
  app13Consumer: 'adopted',
});

// Viewing owns this qualification. The Runtime tuple is retained as the
// qualified source identity; it is not an unlanded Runtime port.
export const VIEWING_QUALIFICATIONS = Object.freeze([
  Object.freeze({
    owner: 'Viewing',
    port: 'public13-one-root-host-catalog',
    status: 'qualified',
    source: RUNTIME13.source,
    tree: RUNTIME13.tree,
    sourceTuple: Object.freeze({
      agent: Object.freeze({ source: AGENT13.source, tree: AGENT13.tree }),
      runtime: Object.freeze({ source: RUNTIME13.source, tree: RUNTIME13.tree }),
    }),
    evidence: Object.freeze({
      central: Object.freeze({ test: 'central14650', result: 'PASS', passed: 1 }),
      oneRootHost: Object.freeze({ test: 'one-root-host', result: 'PASS', passed: 1, duration: '44.14s' }),
    }),
  }),
]);

// Flat owner-port status for this one frozen five-case + tab-audio tuple.
// These are merge/readiness facts, not alternate source tuples.
export const OWNER_PORTS = Object.freeze([
  Object.freeze({ owner: 'App', port: 'complete-cap-current-join', status: 'integrated', source: 'a8283307a7a5537a95988031b385ef28df7524ea' }),
  Object.freeze({ owner: 'App', port: 'track-inspector-preservation', status: 'integrated', source: 'a04f90cf60eac69a5079f0ab03188abcbd1571fc6' }),
  Object.freeze({ owner: 'App', port: 'native-frame-fixture', status: 'integrated', source: 'f084855eff0c40a464a166297d43536458ee4ca4' }),
  Object.freeze({ owner: 'App', port: 'player-tab-audio-instrument', status: 'integrated', source: '379c19509ddb4f100d192c0e52d1307abc3c7a00' }),
  Object.freeze({ owner: 'Agent', port: 'public13-normal-pin', status: 'verified', source: AGENT13.source }),
]);

export const MISSING_OWNER_PORTS = Object.freeze(OWNER_PORTS.filter(({ status }) => status === 'pending-owner-merge'));

const OWN_LEAF = new Set([
  'tests/e2e/timeline/viewing-parity/cases.ts',
  'tests/e2e/timeline/viewing-parity/canvas.test.ts',
  'tests/e2e/timeline/viewing-parity/tab-audio.ts',
  'tests/e2e/timeline/viewing-parity/tab-audio.test.ts',
  'tests/e2e/timeline/viewing-parity/tab-audio.controller.mjs',
  'tests/e2e/timeline/viewing-parity/tab-audio.controller.test.mjs',
]);

function git(root, args) {
  try {
    return execFileSync('git', ['-C', root, ...args], { encoding: 'utf8' }).trim();
  } catch (error) {
    // The sandbox can report EPERM after git has successfully returned its
    // output. Preserve that output; genuine non-zero git failures still fail
    // closed below.
    if (error.status === 0 && typeof error.stdout === 'string') return error.stdout.trim();
    throw error;
  }
}
function sha256(bytes) {
  return createHash('sha256').update(bytes).digest('hex');
}

function tarRegularMembers(archive) {
  const bytes = gunzipSync(readFileSync(archive));
  const members = [];
  for (let offset = 0; offset + 512 <= bytes.length;) {
    const header = bytes.subarray(offset, offset + 512);
    if (header.every(byte => byte === 0)) break;
    const name = header.subarray(0, 100).toString('utf8').replace(/\0.*$/, '');
    const sizeText = header.subarray(124, 136).toString('ascii').replace(/\0.*$/, '').trim();
    const size = sizeText ? Number.parseInt(sizeText, 8) : 0;
    const type = header[156];
    if (type === 0 || type === 48) members.push(name);
    offset += 512 + Math.ceil(size / 512) * 512;
  }
  return members;
}

/** Keep the frozen APP13 fact intact while allowing a manager to select a later
 * clean App checkout by supplying both literal identities at invocation time. */
export function readAppSourceSelection(env = process.env) {
  const sourcePresent = Object.prototype.hasOwnProperty.call(env, APP_SOURCE_ENV);
  const treePresent = Object.prototype.hasOwnProperty.call(env, APP_TREE_ENV);
  if (!sourcePresent && !treePresent) return APP13;
  const source = env[APP_SOURCE_ENV]?.trim();
  const tree = env[APP_TREE_ENV]?.trim();
  if (!source || !tree) throw new Error(`${APP_SOURCE_ENV} and ${APP_TREE_ENV} must be supplied together`);
  if (!FULL_SHA.test(source) || !FULL_SHA.test(tree)) {
    throw new Error(`${APP_SOURCE_ENV} and ${APP_TREE_ENV} must be full 40-character lowercase SHAs`);
  }
  return Object.freeze({ source, tree, status: 'externally-pinned' });
}

export function hashTree(root) {
  const entries = [];
  function visit(directory, prefix = '') {
    for (const name of readdirSync(directory).sort()) {
      const absolute = path.join(directory, name);
      const relative = `${prefix}${name}`;
      const stat = lstatSync(absolute);
      if (stat.isDirectory()) visit(absolute, `${relative}/`);
      else if (stat.isFile()) entries.push([relative, stat.mode & 0o111 ? 'executable' : 'file', sha256(readFileSync(absolute))]);
      else if (stat.isSymbolicLink()) entries.push([relative, 'symlink', sha256(Buffer.from(readlinkSync(absolute)))]);
      else throw new Error(`unsupported tree member: ${absolute}`);
    }
  }
  visit(root);
  entries.sort(([left], [right]) => left < right ? -1 : left > right ? 1 : 0);
  return { sha256: sha256(Buffer.from(JSON.stringify(entries))), fileCount: entries.length };
}

export function assertPhysicalPrivateGraph(root) {
  if (realpathSync(root) !== path.resolve(root) || !lstatSync(root).isDirectory()) {
    throw new Error('private dependency graph must be a real directory');
  }
  const links = new Map();
  function visit(directory) {
    for (const name of readdirSync(directory)) {
      const absolute = path.join(directory, name);
      const stat = lstatSync(absolute);
      if (stat.isDirectory()) visit(absolute);
      else if (stat.isSymbolicLink()) {
        const target = realpathSync(absolute);
        if (readlinkSync(absolute).startsWith('/') || !target.startsWith(`${path.resolve(root)}/`) || !statSync(target).isFile()) {
          throw new Error(`private dependency link escapes graph: ${absolute}`);
        }
      } else if (stat.isFile()) {
        const key = `${stat.dev}:${stat.ino}`;
        const entry = links.get(key) ?? { count: 0, links: stat.nlink, path: absolute };
        entry.count += 1;
        links.set(key, entry);
      } else throw new Error(`private dependency graph has unsupported member: ${absolute}`);
    }
  }
  visit(root);
  for (const entry of links.values()) {
    if (entry.count !== entry.links) throw new Error(`private dependency graph shares a file: ${entry.path}`);
  }
  return hashTree(root);
}

export function assertCandidateTuple(
  tuple = { app: readAppSourceSelection(), agent: AGENT13, runtime: RUNTIME13, composition: COMPOSITION13 },
  app = readAppSourceSelection(),
) {
  for (const [name, expected] of Object.entries({ app, agent: AGENT13, runtime: RUNTIME13 })) {
    if (tuple[name]?.source !== expected.source || tuple[name]?.tree !== expected.tree) {
      throw new Error(`${name}13 candidate tuple changed; expected ${expected.source}/${expected.tree}`);
    }
  }
  if (tuple.composition?.source !== COMPOSITION13.source || tuple.composition?.artifact !== COMPOSITION13.artifact) {
    throw new Error(`composition13 candidate changed; expected ${COMPOSITION13.source}/${COMPOSITION13.artifact}`);
  }
  return tuple;
}

export function assertRuntimeArtifact(facts = RUNTIME13_ARTIFACT) {
  if (facts.producer !== RUNTIME13_ARTIFACT.producer
    || facts.source !== RUNTIME13_ARTIFACT.source
    || facts.tree !== RUNTIME13_ARTIFACT.tree
    || facts.version !== RUNTIME13_ARTIFACT.version
    || facts.schema !== RUNTIME13_ARTIFACT.schema
    || facts.componentManifest !== RUNTIME13_ARTIFACT.componentManifest
    || facts.artifactCount !== RUNTIME13_ARTIFACT.artifactCount) {
    throw new Error('official Runtime artifact producer facts changed');
  }
  return facts;
}

export function assertAppOwnerBase(appRoot, app = readAppSourceSelection()) {
  const source = typeof app === 'string' ? app : app.source;
  const selectedTree = git(appRoot, ['rev-parse', `${source}^{tree}`]);
  if (typeof app !== 'string' && selectedTree !== app.tree) {
    throw new Error(`selected App source/tree does not name the selected commit: ${source}/${app.tree}`);
  }
  const integration = git(appRoot, ['rev-parse', `${APP_OWNER_INTEGRATION_REF}^{commit}`]);
  if (git(appRoot, ['merge-base', source, integration]) !== source) {
    throw new Error(`selected App source ${source} is not an actual App integration ancestor`);
  }
  return { source, tree: selectedTree };
}

export function assertAppOwnLeaf(appRoot, base = readAppSourceSelection()) {
  const source = typeof base === 'string' ? base : base.source;
  assertAppOwnerBase(appRoot, base);
  const changed = git(appRoot, ['diff', '--name-only', `${source}...HEAD`]).split('\n').filter(Boolean);
  const forbidden = changed.filter(file => !OWN_LEAF.has(file));
  if (forbidden.length) throw new Error(`App product/root/pin/DTO/source changes are not owned by this leaf: ${forbidden.join(', ')}`);
  return changed;
}

export function assertExactGraph({ appRoot, agentRoot, runtimeRoot, app = readAppSourceSelection() }) {
  const appBase = git(appRoot, ['merge-base', app.source, 'HEAD']);
  if (appBase !== app.source) throw new Error(`App is not based on selected App source ${app.source}`);
  if (git(agentRoot, ['rev-parse', 'HEAD']) !== AGENT13.source) throw new Error('Agent13 source is not the approved keeper');
  if (git(runtimeRoot, ['rev-parse', 'HEAD']) !== RUNTIME13.source) throw new Error('Runtime13 source is not the approved producer');
  if (git(agentRoot, ['rev-parse', 'HEAD^{tree}']) !== AGENT13.tree) throw new Error('Agent13 tree is not the approved keeper');
  if (git(runtimeRoot, ['rev-parse', 'HEAD^{tree}']) !== RUNTIME13.tree) throw new Error('Runtime13 tree is not the approved producer');
  for (const [name, root] of Object.entries({ app: appRoot, agent: agentRoot, runtime: runtimeRoot })) {
    if (git(root, ['status', '--porcelain'])) throw new Error(`${name} source must be clean before capture`);
  }
  assertAppOwnLeaf(appRoot, app);
  return { app: git(appRoot, ['rev-parse', 'HEAD']), agent: AGENT13.source, runtime: RUNTIME13.source };
}

export function assertFrozenRuntimeGraph(project = AGENT13_RUNTIME.project) {
  if (realpathSync(project) !== path.resolve(AGENT13_RUNTIME.project)) {
    throw new Error(`Runtime project must be ${AGENT13_RUNTIME.project}`);
  }
  const lock = sha256(readFileSync(path.join(project, 'package-lock.json')));
  if (lock !== AGENT13_RUNTIME.lock) throw new Error(`Runtime lock changed: ${lock}`);
  const graph = assertPhysicalPrivateGraph(path.join(project, 'node_modules'));
  if (graph.sha256 !== AGENT13_RUNTIME.graph || graph.fileCount !== AGENT13_RUNTIME.graphFileCount) {
    throw new Error(`Runtime dependency graph changed: ${graph.sha256}/${graph.fileCount}`);
  }
  for (const [relative, expected] of Object.entries(AGENT13_RUNTIME.peers)) {
    const actual = sha256(readFileSync(path.join(project, relative)));
    if (actual !== expected) throw new Error(`Runtime peer changed: ${relative}`);
  }
  const artifact = path.join(project, 'artifacts', 'banodoco-timeline-composition-0.0.13.tgz');
  if (sha256(readFileSync(artifact)) !== COMPOSITION13.artifact) {
    throw new Error('Runtime public13 Composition artifact changed');
  }
  const members = tarRegularMembers(artifact);
  if (members.length !== COMPOSITION13.regularMembers || new Set(members).size !== members.length) {
    throw new Error(`Runtime public13 Composition artifact must contain ${COMPOSITION13.regularMembers} regular members`);
  }
  return { lock, graph, peers: AGENT13_RUNTIME.peers, artifact: COMPOSITION13.artifact, regularMembers: members.length };
}

export function assertNode20(executable = process.execPath) {
  const actual = realpathSync(executable);
  if (process.version !== NODE20.version || actual !== realpathSync(NODE20.executable)) {
    throw new Error(`selected Node must be ${NODE20.version} at ${NODE20.executable}`);
  }
  const digest = sha256(readFileSync(actual));
  if (digest !== NODE20.sha256) throw new Error(`unexpected Node executable digest: ${digest}`);
  return { version: process.version, executable: actual, sha256: digest };
}

export function assertChrome155(binary = CHROME155.executable) {
  const version = execFileSync(binary, ['--version'], { encoding: 'utf8' }).trim();
  if (!version.includes(`Chrome ${CHROME155.version}`)) throw new Error(`unexpected Chrome: ${version}`);
  const packageVersion = execFileSync('dpkg-query', ['-W', '-f=${Version}', 'google-chrome-stable'], { encoding: 'utf8' }).trim();
  if (packageVersion !== CHROME155.packageVersion) throw new Error(`unexpected Chrome package: ${packageVersion}`);
  const digest = sha256(readFileSync(binary));
  if (digest !== CHROME155.sha256) throw new Error(`unexpected Chrome digest: ${digest}`);
  const tree = hashTree(path.dirname(realpathSync(binary)));
  if (tree.sha256 !== CHROME155.treeSha256 || tree.fileCount !== CHROME155.treeFileCount) {
    throw new Error(`unexpected Chrome155 full tree: ${tree.sha256}/${tree.fileCount}`);
  }
  return { version, packageVersion, digest, tree };
}

export function assertResources(root) {
  const { bavail, bsize } = statfsSync(root);
  if (bavail * bsize < MIN_FREE_BYTES) throw new Error('standing 10 GiB free-disk floor is not met');
  return bavail * bsize;
}

export function assertOwnedShortTemp() {
  const directory = mkdtempSync(path.join('/tmp', SHORT_TEMP_PREFIX));
  try {
    const stat = statSync(directory);
    if ((stat.mode & 0o777) !== 0o700 || path.dirname(directory) !== '/tmp') {
      throw new Error('tab capture temp must be an owned direct /tmp directory with mode 0700');
    }
    if (directory.length + '/com.google.Chrome/SingletonSocket'.length >= 108) {
      throw new Error('tab capture temp leaves Chrome singleton socket path too long');
    }
    return directory;
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
}

export function assertCompletedAppConsumer(appRoot, app = readAppSourceSelection()) {
  if (app.status !== 'adopted' && app.status !== 'externally-pinned') {
    throw new Error('App public13 consumer is not adopted; --ready remains refused');
  }
  if (git(appRoot, ['rev-parse', 'HEAD']) !== app.source || git(appRoot, ['rev-parse', 'HEAD^{tree}']) !== app.tree) {
    throw new Error('App public13 consumer source/tree is not the selected exact source');
  }
}

export function assertOwnerPorts() {
  if (MISSING_OWNER_PORTS.length) {
    const missing = MISSING_OWNER_PORTS.map(({ owner, port, source }) => `${owner}/${port} (${source})`).join(', ');
    throw new Error(`readiness refused: missing owner ports: ${missing}`);
  }
  return OWNER_PORTS;
}

export function assertFreshGrantAndMarker(appRoot) {
  const grantPath = process.env.TAB_AUDIO_GRANT_PATH;
  const markerPath = process.env.TAB_AUDIO_RUN_MARKER;
  if (!grantPath || !markerPath) throw new Error('fresh tab-audio grant and one-shot marker are required');
  const grant = JSON.parse(readFileSync(grantPath, 'utf8'));
  if (grant.approved !== true || grant.profile !== 'native-codec-chrome155'
    || grant.browserExecutable !== CHROME155.executable || grant.browserVersion !== CHROME155.version
    || grant.browserExecutableSha256 !== CHROME155.sha256 || grant.browserTreeSha256 !== CHROME155.treeSha256
    || grant.nodeVersion !== NODE20.version || grant.nodeExecutableSha256 !== NODE20.sha256
    || grant.sourceSha !== git(appRoot, ['rev-parse', 'HEAD']) || grant.sourceTree !== git(appRoot, ['rev-parse', 'HEAD^{tree}'])) {
    throw new Error('tab-audio grant does not match the selected source and environment');
  }
  const marker = JSON.parse(readFileSync(markerPath, 'utf8'));
  if (marker.sourceSha !== grant.sourceSha || marker.sourceTree !== grant.sourceTree) {
    throw new Error('one-shot marker does not match the fresh tab-audio grant');
  }
  return { grant, marker };
}

export function runParityPreflight(appRoot, agentRoot, runtimeRoot) {
  const helper = path.join(appRoot, 'tests/e2e/timeline/viewing-parity/harness.ts');
  const script = `import { assertRunBoundary, assertSourceVersionsUnchanged, sourceVersions } from ${JSON.stringify(pathToFileURL(helper).href)};\nconst profile = 'native-codec-chrome155';\nawait assertRunBoundary();\nconst before = await sourceVersions(profile);\nawait assertRunBoundary();\nconst after = await sourceVersions(profile);\nassertSourceVersionsUnchanged(before, after);\n`;
  const result = spawnSync(NODE20.executable, ['--import', 'tsx', '--input-type=module', '--eval', script], {
    cwd: appRoot,
    env: { ...process.env, ASTRID_CHECKOUT: agentRoot, ASTRID_RUNTIME_CHECKOUT: runtimeRoot },
    encoding: 'utf8',
  });
  if (result.status !== 0) throw new Error(`existing viewing-parity preflight failed: ${result.stderr || result.stdout}`);
  return result.stdout;
}

export function discover(appRoot) {
  const playwright = path.resolve(appRoot, 'node_modules', '@playwright', 'test', 'cli.js');
  const directory = mkdtempSync(path.join('/tmp', SHORT_TEMP_PREFIX));
  const stdoutPath = path.join(directory, 'discovery.stdout');
  const stderrPath = path.join(directory, 'discovery.stderr');
  let result;
  let output;
  try {
    const stdout = openSync(stdoutPath, 'w');
    const stderr = openSync(stderrPath, 'w');
    try {
      result = spawnSync(NODE20.executable, [playwright, 'test', '--config', 'playwright.viewing-parity.native-codec.config.ts', '--list'], {
        cwd: appRoot, stdio: ['ignore', stdout, stderr],
      });
    } finally {
      closeSync(stdout);
      closeSync(stderr);
    }
    output = `${readFileSync(stdoutPath, 'utf8')}${readFileSync(stderrPath, 'utf8')}`;
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
  if (result.status !== 0 || result.error) {
    throw new Error(`offline Playwright discovery failed: ${result.error?.message ?? output}`);
  }
  const cases = readFileSync(path.join(appRoot, 'tests/e2e/timeline/viewing-parity/cases.ts'), 'utf8');
  const required = [
    "test('normal App Render action downloads",
    "test('fixture readiness seeks",
    "test('compares native-size actual Player frames",
    "test('captures the actual Player page as one native-PTS VP8/Opus tab stream",
    "test('picture-only one-host patch",
  ];
  const hasTabAudioCase = cases.includes(required[3]);
  const expectedCount = hasTabAudioCase ? 5 : 4;
  if (!new RegExp(`^Total: ${expectedCount} tests in 1 file$`, 'm').test(output)) {
    throw new Error(`offline discovery must find exactly ${expectedCount} parity cases from current sources`);
  }
  if (required.slice(0, 3).some(testName => !cases.includes(testName)) || !cases.includes(required[4])) {
    throw new Error('offline discovery is missing a current parity case');
  }
  if (hasTabAudioCase && cases.indexOf(required[3]) > cases.indexOf(required[4])) {
    throw new Error('offline discovery did not find the tab capture case in order');
  }
  return `discovered exactly ${expectedCount} current native-codec-chrome155 parity cases`;
}

export function readControlReport(reportPath) {
  const report = JSON.parse(readFileSync(reportPath, 'utf8'));
  if (report.physicalMixClaim === true) {
    throw new Error('controller report must not promote the unverified physical mix');
  }
  return report;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const [command, appRoot = process.cwd(), agentRoot, runtimeRoot] = process.argv.slice(2);
  if (command === '--discover') {
    process.stdout.write(discover(appRoot));
  } else if (command === '--ready') {
    if (!agentRoot || !runtimeRoot) throw new Error('--ready requires app, agent, and runtime roots');
    const app = readAppSourceSelection();
    assertCandidateTuple({ app, agent: AGENT13, runtime: RUNTIME13, composition: COMPOSITION13 }, app);
    assertRuntimeArtifact();
    assertOwnerPorts();
    assertCompletedAppConsumer(appRoot, app);
    assertExactGraph({ appRoot, agentRoot, runtimeRoot, app });
    assertResources(appRoot);
    assertOwnedShortTemp();
    const remotionProject = process.env.ASTRID_REMOTION_PROJECT_DIR;
    if (!remotionProject) throw new Error('ASTRID_REMOTION_PROJECT_DIR must select the frozen private graph');
    assertPhysicalPrivateGraph(path.join(appRoot, 'node_modules'));
    assertFrozenRuntimeGraph(remotionProject);
    assertNode20();
    assertChrome155();
    discover(appRoot);
    runParityPreflight(appRoot, agentRoot, runtimeRoot);
    assertFreshGrantAndMarker(appRoot);
    process.stdout.write('READY: offline preflight passed; no capture or physical-mix claim made\n');
  } else {
    throw new Error('usage: tab-audio.controller.mjs --discover <app-root> | --ready <app-root> <agent-root> <runtime-root>');
  }
}
