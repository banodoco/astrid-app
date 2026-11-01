#!/usr/bin/env node

/**
 * Manager-gated Gate3 caller for the existing mounted native-None case.
 *
 * This is a source/preflight wrapper only. It deliberately delegates to the
 * real three-products suite and does not add a fixture, UI surface, or
 * acceptance path. The older current013 wrappers remain historical and keep
 * their original source tuple.
 */
import { createHash } from 'node:crypto';
import { execFileSync, spawnSync } from 'node:child_process';
import {
  accessSync, constants, existsSync, lstatSync, readFileSync, readdirSync, realpathSync, statSync,
} from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

export const CURRENT014_GATE3 = Object.freeze({
  agent: Object.freeze({
    commit: '6efc81500a0e0688c2bb41e736503f0fc3e04abb',
    tree: '2ed2b8a12b5b3391ca221ba6ff05390f71a73556',
  }),
  runtime: Object.freeze({
    commit: '95bd3c5f6d00e9bc8cc8cbe5ef510b68ed660f3c',
    tree: 'd3a290b407fa61e6ab2d476f50c068073f70df00',
    producerVersion: 'sha256:54205b3ecb55038e416b31af936c9af26afa30dc1b05da16157ee4d861fe05ac',
    schemaDigest: 'sha256:7d4afa05962b8cd61643213fc79cdde41e16046c4e2a777bd299b48af0f31816',
    componentManifest: 'sha256:1ad76db27c1d9716bb234f811bf63e1f5898cb3d5f9b835a821765e6cad895e5',
    artifactCount: 76,
  }),
  vendor: Object.freeze({
    commit: '091aa23ec83ea05ffd3b0115a640230d51c8c429',
    tree: 'e3ae90fe482ba6cad6c3f94069127faf76ebceb6',
    module: 'astrid/packs/rendering/elements/catalog.ts',
    moduleSha256: 'fc53e754326cd9fc9bc3e5233026fbc70ac6a4c5fd81a9d0b2c857665f13c661',
  }),
  composition: Object.freeze({
    archive: 'banodoco-timeline-composition-0.0.13.tgz',
    sha256: 'sha256:9412ae25c306d5118241f4d631e8eecc6eef9b2fb5a98302d40938e9f6d54738',
    bytes: 58477,
    fileCount: 77,
    version: '0.0.13',
    packageResolved: 'file:vendor/artifacts/banodoco-timeline-composition-0.0.13.tgz',
  }),
});

const FULL_SHA = /^[a-f0-9]{40}$/;
const APP_METADATA = 'src/integrations/runtime/generated-contract-metadata.ts';
const AGENT_METADATA = 'astrid_runtime_client/contract_metadata.py';
const TEST_SOURCE = 'tests/e2e/local/three-products.spec.ts';
const CASE_TITLE = 'M2 native None single:';
const CASE_FULL_TITLE = 'M2 native None single: ordinary default crossfade clears raw mirrors, reloads, retries exactly after restart and undoes through Runtime';
const CASE_GREP = '^.*M2 native None single:';
export const CURRENT014_GATE3_CASE = Object.freeze({
  title: CASE_TITLE,
  fullTitle: CASE_FULL_TITLE,
  grep: CASE_GREP,
  config: 'playwright.three-products.config.ts',
  testDir: 'tests/e2e/local',
  testMatch: 'three-products*.spec.ts',
  command: 'npm',
  argv: Object.freeze(['run', 'test:e2e:three-products', '--', '--grep', CASE_GREP]),
});

function fail(message) {
  throw new Error(`[current014/gate3] ${message}`);
}

function required(env, name) {
  const value = env[name]?.trim();
  if (!value) fail(`${name} is required; no moving-repo default is allowed`);
  return value;
}

function requiredSha(env, name) {
  const value = required(env, name);
  if (!FULL_SHA.test(value)) fail(`${name} must be a full 40-character lowercase SHA`);
  return value;
}

function requiredPath(env, name) {
  const value = required(env, name);
  if (!path.isAbsolute(value)) fail(`${name} must be an absolute path`);
  if (!existsSync(value)) fail(`${name} does not exist: ${value}`);
  if (!statSync(value).isDirectory()) fail(`${name} must name a directory: ${value}`);
  return realpathSync(value);
}

function requiredFile(env, name) {
  const value = required(env, name);
  if (!path.isAbsolute(value)) fail(`${name} must be an absolute path`);
  if (!existsSync(value) || !statSync(value).isFile()) fail(`${name} must name a file: ${value}`);
  return realpathSync(value);
}

function requiredExecutable(env, name) {
  const value = required(env, name);
  if (!path.isAbsolute(value)) fail(`${name} must be an absolute path`);
  if (!existsSync(value) || !statSync(value).isFile()) fail(`${name} must name a file: ${value}`);
  try { accessSync(value, constants.X_OK); } catch { fail(`${name} must be executable: ${value}`); }
  return value;
}

function git(root, ...args) {
  try {
    return execFileSync('git', ['-C', root, ...args], {
      encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], timeout: 10_000,
    }).trim();
  } catch (error) {
    fail(`git ${args.join(' ')} failed in ${root}: ${error.message}`);
  }
}

function sha256File(file) {
  return `sha256:${createHash('sha256').update(readFileSync(file)).digest('hex')}`;
}

function jsonFile(file) {
  try { return JSON.parse(readFileSync(file, 'utf8')); }
  catch (error) { fail(`cannot read JSON ${file}: ${error.message}`); }
}

function digestEntries(entries) {
  const hash = createHash('sha256');
  for (const [name, bytes] of entries) {
    hash.update(name);
    hash.update('\0');
    hash.update(String(bytes.length));
    hash.update('\0');
    hash.update(bytes);
    hash.update('\n');
  }
  return `sha256:${hash.digest('hex')}`;
}

function regularFiles(root) {
  const files = [];
  const visit = (directory, prefix = '') => {
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      const relative = prefix ? `${prefix}/${entry.name}` : entry.name;
      const file = path.join(directory, entry.name);
      if (entry.isDirectory()) visit(file, relative);
      else if (entry.isFile()) files.push([relative, readFileSync(file)]);
      else fail(`installed Composition package contains a non-regular member: ${file}`);
    }
  };
  visit(root);
  return files.sort(([a], [b]) => a.localeCompare(b));
}

function archivePayload(archive) {
  const members = execFileSync('tar', ['-tzf', archive], { encoding: 'utf8' }).trim().split('\n')
    .filter((member) => member && !member.endsWith('/'));
  return members.map((member) => {
    const relative = member.slice('package/'.length);
    if (!member.startsWith('package/') || relative.split('/').includes('..')) {
      fail(`Composition archive contains an unsafe member: ${member}`);
    }
    return [relative, execFileSync('tar', ['-xOf', archive, member])];
  }).sort(([a], [b]) => a.localeCompare(b));
}

function compareInstalledComposition(archive, installed) {
  const expected = archivePayload(archive);
  const actual = regularFiles(installed);
  if (actual.length !== expected.length || actual.some(([name], index) => name !== expected[index][0])) {
    fail(`installed Composition package does not contain the archive's exact ${expected.length}-file payload`);
  }
  for (let index = 0; index < expected.length; index++) {
    if (!expected[index][1].equals(actual[index][1])) {
      fail(`installed Composition bytes differ for ${expected[index][0]}`);
    }
  }
  return digestEntries(actual);
}

function checkClean(root, label) {
  const status = git(root, 'status', '--porcelain', '--untracked-files=normal');
  if (status) fail(`${label} source is dirty:\n${status}`);
}

function checkMetadata(root, label, fileName) {
  const file = path.join(root, fileName);
  const source = readFileSync(file, 'utf8');
  const value = (name) => {
    const match = source.match(new RegExp(`${name}\\s*=\\s*["']([^"']+)["']`));
    if (!match) fail(`${label} metadata is missing ${name}: ${file}`);
    return match[1];
  };
  if (value('SCHEMA_DIGEST') !== CURRENT014_GATE3.runtime.schemaDigest) fail(`${label} schema digest is not current Runtime95`);
  if (value('COMPONENT_MANIFEST_SHA256') !== CURRENT014_GATE3.runtime.componentManifest) fail(`${label} component manifest is not current Runtime95`);
  if (label === 'App' && value('CONTRACT_VERSION') !== '0.2.14') fail('App contract version is not 0.2.14');
  return sha256File(file);
}

function checkRuntimeLock(root, label, producer = null, python = null) {
  const file = path.join(root, 'runtime.lock.json');
  const lock = jsonFile(file);
  if (lock.producer !== 'astrid-runtime' || lock.source_commit !== CURRENT014_GATE3.runtime.commit) {
    fail(`${label} Runtime lock producer/source is not Runtime95`);
  }
  if (lock.producer_version !== CURRENT014_GATE3.runtime.producerVersion) fail(`${label} Runtime lock version is not the all76 artifact`);
  if (producer) {
    const checker = label === 'App' ? process.execPath : python;
    const checkerScript = label === 'App' ? path.join(root, 'scripts/vendor-lock.mjs') : path.join(root, 'scripts/vendor_lock.py');
    if (!checker) fail(`${label} vendor-lock checker Python is required`);
    try {
      execFileSync(checker, [checkerScript, 'check', file, '--producer', producer], {
        cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'],
      });
    } catch (error) {
      const detail = error.stderr?.toString().trim() || error.stdout?.toString().trim() || error.message;
      fail(`${label} vendor-lock check failed: ${detail}`);
    }
  }
  return sha256File(file);
}

export { checkRuntimeLock };

function checkRuntimeProducerManifest(root, python) {
  const file = path.join(root, 'contract/artifacts.json');
  const manifest = jsonFile(file);
  if (manifest.producer !== 'astrid-runtime' || manifest.version !== CURRENT014_GATE3.runtime.producerVersion
    || Object.keys(manifest.artifacts ?? {}).length !== CURRENT014_GATE3.runtime.artifactCount) {
    fail('Runtime producer is not the all76 artifact manifest');
  }
  try {
    execFileSync(python, [path.join(root, 'scripts/artifact_manifest.py'), '--check'], {
      cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'],
    });
  } catch (error) {
    const detail = error.stderr?.toString().trim() || error.stdout?.toString().trim() || error.message;
    fail(`Runtime producer artifact manifest check failed: ${detail}`);
  }
  return sha256File(file);
}

export { checkRuntimeProducerManifest };

function checkCompositionArchive(root, label, relativeDirectory) {
  const file = path.join(root, relativeDirectory, CURRENT014_GATE3.composition.archive);
  if (!existsSync(file)) fail(`${label} Composition archive is missing: ${file}`);
  if (statSync(file).size !== CURRENT014_GATE3.composition.bytes) fail(`${label} Composition archive byte count is not 58477`);
  if (sha256File(file) !== CURRENT014_GATE3.composition.sha256) fail(`${label} Composition archive digest is not public13/9412`);
  const members = execFileSync('tar', ['-tzf', file], { encoding: 'utf8' }).trim().split('\n')
    .filter((member) => member && !member.endsWith('/'));
  if (members.length !== CURRENT014_GATE3.composition.fileCount || new Set(members).size !== members.length) {
    fail(`${label} Composition archive must contain exactly 77 regular files`);
  }
  if (members.some((member) => !member.startsWith('package/') || member.slice('package/'.length).split('/').includes('..'))) {
    fail(`${label} Composition archive contains an unsafe member`);
  }
  return { digest: sha256File(file), bytes: statSync(file).size, fileCount: members.length };
}

function checkCompositionPackage(root) {
  const packageJson = jsonFile(path.join(root, 'package.json'));
  const lock = jsonFile(path.join(root, 'package-lock.json'));
  if (packageJson.dependencies?.['@banodoco/timeline-composition'] !== CURRENT014_GATE3.composition.packageResolved) {
    fail('App package.json does not pin Composition13 by local archive');
  }
  const entry = lock.packages?.['node_modules/@banodoco/timeline-composition'];
  if (entry?.version !== CURRENT014_GATE3.composition.version || entry?.resolved !== CURRENT014_GATE3.composition.packageResolved) {
    fail('App package-lock.json does not pin the same Composition13 archive');
  }
}

function checkGraph(env) {
  const graph = requiredPath(env, 'TIMELINE_CURRENT014_GATE3_GRAPH_NODE_MODULES');
  if (lstatSync(env.TIMELINE_CURRENT014_GATE3_GRAPH_NODE_MODULES).isSymbolicLink()) {
    fail('effective graph must be a physical directory, not a symlink');
  }
  if (path.basename(graph) !== 'node_modules') fail('effective graph must be its physical node_modules directory');
  if (graph === '/home/user/work/app/node_modules' || graph.startsWith('/home/user/work/app/node_modules/')
    || graph === '/home/user/work/runtimes' || graph.startsWith('/home/user/work/runtimes/')) {
    fail('effective graph resolves into a shared dependency install');
  }
  const composition = path.join(graph, '@banodoco/timeline-composition');
  if (!existsSync(composition) || lstatSync(composition).isSymbolicLink()
    || !statSync(composition).isDirectory()
    || jsonFile(path.join(composition, 'package.json')).version !== CURRENT014_GATE3.composition.version) {
    fail('effective graph does not expose Composition13');
  }
  const compositionReal = realpathSync(composition);
  if (compositionReal === '/home/user/work/app/node_modules' || compositionReal.startsWith('/home/user/work/app/node_modules/')
    || compositionReal === '/home/user/work/runtimes' || compositionReal.startsWith('/home/user/work/runtimes/')) {
    fail('effective graph Composition resolves into a shared dependency install');
  }
  const ready = requiredFile(env, 'TIMELINE_CURRENT014_GATE3_GRAPH_READY');
  const lease = requiredFile(env, 'TIMELINE_CURRENT014_GATE3_GRAPH_LEASE');
  const readyText = readFileSync(ready, 'utf8');
  const leaseText = readFileSync(lease, 'utf8');
  if (!/\bREADY\b/.test(readyText)) fail(`effective graph is not marked READY: ${ready}`);
  if (!/(?:^|\n)status=(?:READY|ACTIVE)(?:\n|$)/.test(leaseText)
    || /(?:^|\n)(?:status=)?(?:RELEASED|EXPIRED)(?:\n|$)/.test(leaseText)) {
    fail(`effective graph lease is not active: ${lease}`);
  }
  if (!new RegExp(`(?:graph|node_modules)=${graph.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}(?:\\n|$)`).test(leaseText)) {
    fail(`effective graph lease does not bind the selected node_modules path: ${lease}`);
  }
  if (!new RegExp(`(?:archive_sha256|composition_sha256)=${CURRENT014_GATE3.composition.sha256.slice('sha256:'.length)}(?:\\n|$)`).test(leaseText)) {
    fail(`effective graph lease does not bind Composition13 archive bytes: ${lease}`);
  }
  return Object.freeze({ graph, composition: realpathSync(composition), ready, lease });
}

export function readCurrent014Gate3Inputs(env = process.env, appRoot = process.cwd()) {
  const appSha = requiredSha(env, 'TIMELINE_CURRENT014_GATE3_APP_SHA');
  const appTree = requiredSha(env, 'TIMELINE_CURRENT014_GATE3_APP_TREE');
  const agentSha = requiredSha(env, 'TIMELINE_CURRENT014_GATE3_AGENT_SHA');
  const runtimeSha = requiredSha(env, 'TIMELINE_CURRENT014_GATE3_RUNTIME_SHA');
  if (agentSha !== CURRENT014_GATE3.agent.commit) fail(`Agent must be ${CURRENT014_GATE3.agent.commit}`);
  if (runtimeSha !== CURRENT014_GATE3.runtime.commit) fail(`Runtime must be ${CURRENT014_GATE3.runtime.commit}`);
  if (!path.isAbsolute(appRoot)) fail(`App root must be absolute: ${appRoot}`);
  if (env.ASTRID_APP_DIRECT_DIST) fail('ASTRID_APP_DIRECT_DIST is forbidden; use the normal hosted build helper');
  const graph = checkGraph(env);
  return Object.freeze({
    app: realpathSync(appRoot), appSha, appTree, agentSha, runtimeSha,
    agent: requiredPath(env, 'ASTRID_CHECKOUT'), runtime: requiredPath(env, 'ASTRID_RUNTIME_CHECKOUT'),
    runtimeProducer: requiredPath(env, 'TIMELINE_CURRENT014_GATE3_RUNTIME_PRODUCER_CHECKOUT'),
    vendor: requiredPath(env, 'TIMELINE_CURRENT014_GATE3_VENDOR_SOURCE_CHECKOUT'),
    appKeeper: requiredPath(env, 'TIMELINE_CURRENT014_GATE3_APP_KEEPER'),
    agentPython: requiredExecutable(env, 'ASTRID_PYTHON'),
    runtimePython: requiredExecutable(env, 'ASTRID_RUNTIME_PYTHON'),
    ...graph,
  });
}

function checkAppSource(input) {
  if (git(input.app, 'rev-parse', '--show-toplevel') !== input.app) fail(`App root is not the current checkout: ${input.app}`);
  if (realpathSync(input.appKeeper) === input.app) fail('App source keeper must be detached from the synthetic snapshot root');
  if (git(input.appKeeper, 'rev-parse', '--show-toplevel') !== input.appKeeper) fail(`App keeper is not the expected checkout: ${input.appKeeper}`);
  if (git(input.appKeeper, 'rev-parse', 'HEAD') !== input.appSha) fail(`App source keeper commit changed: expected ${input.appSha}`);
  if (git(input.appKeeper, 'rev-parse', 'HEAD^{tree}') !== input.appTree) fail(`App source keeper tree changed: expected ${input.appTree}`);
  if (git(input.app, 'rev-parse', 'HEAD^{tree}') !== input.appTree) fail(`App synthetic snapshot tree changed: expected ${input.appTree}`);
  checkClean(input.appKeeper, 'App source keeper');
  checkClean(input.app, 'App synthetic snapshot');
}

function checkVendor(input) {
  if (input.vendor === input.agent) fail('execution Agent and vendored-source roles must use separate checkouts');
  if (git(input.vendor, 'rev-parse', 'HEAD') !== CURRENT014_GATE3.vendor.commit
    || git(input.vendor, 'rev-parse', 'HEAD^{tree}') !== CURRENT014_GATE3.vendor.tree) {
    fail('vendored Astrid source identity changed');
  }
  checkClean(input.vendor, 'Astrid vendor source');
  const sourceModule = path.join(input.vendor, CURRENT014_GATE3.vendor.module);
  if (sha256File(sourceModule) !== `sha256:${CURRENT014_GATE3.vendor.moduleSha256}`) fail('vendored Astrid source module bytes changed');
  const provenance = jsonFile(path.join(input.app, 'vendor/astrid-browser/provenance.json'));
  if (provenance.astrid_commit !== CURRENT014_GATE3.vendor.commit || provenance.astrid_tree !== CURRENT014_GATE3.vendor.tree
    || provenance.files?.[CURRENT014_GATE3.vendor.module] !== CURRENT014_GATE3.vendor.moduleSha256) {
    fail('App Astrid vendor provenance does not describe the separate vendor source role');
  }
  const vendoredModule = path.join(input.app, 'vendor/astrid-browser', CURRENT014_GATE3.vendor.module);
  if (sha256File(vendoredModule) !== `sha256:${CURRENT014_GATE3.vendor.moduleSha256}`
    || !readFileSync(vendoredModule).equals(readFileSync(sourceModule))) {
    fail('App Astrid vendor module bytes do not match the separate vendor source');
  }
}

function checkGraphBytes(input, archive) {
  checkGraph({
    TIMELINE_CURRENT014_GATE3_GRAPH_NODE_MODULES: input.graph,
    TIMELINE_CURRENT014_GATE3_GRAPH_READY: input.ready,
    TIMELINE_CURRENT014_GATE3_GRAPH_LEASE: input.lease,
  });
  return {
    ready: sha256File(input.ready),
    lease: sha256File(input.lease),
    compositionPackage: digestEntries(regularFiles(input.composition)),
    installedComposition: compareInstalledComposition(archive, input.composition),
  };
}

function sourceBytes(input) {
  const files = [
    ['app/package.json', path.join(input.app, 'package.json')],
    ['app/package-lock.json', path.join(input.app, 'package-lock.json')],
    ['app/runtime.lock.json', path.join(input.app, 'runtime.lock.json')],
    ['app/metadata', path.join(input.app, APP_METADATA)],
    ['app/composition', path.join(input.app, 'vendor/artifacts', CURRENT014_GATE3.composition.archive)],
    ['app/vendor-provenance', path.join(input.app, 'vendor/astrid-browser/provenance.json')],
    ['app/test-source', path.join(input.app, TEST_SOURCE)],
    ['agent/runtime.lock.json', path.join(input.agent, 'runtime.lock.json')],
    ['agent/metadata', path.join(input.agent, AGENT_METADATA)],
    ['agent/composition', path.join(input.agent, 'remotion/artifacts', CURRENT014_GATE3.composition.archive)],
    ['runtime/manifest', path.join(input.runtimeProducer, 'contract/artifacts.json')],
    ['vendor/module', path.join(input.vendor, CURRENT014_GATE3.vendor.module)],
  ];
  return Object.fromEntries(files.map(([name, file]) => [name, { bytes: statSync(file).size, sha256: sha256File(file) }]));
}

export function checkCurrent014Gate3Sources(input) {
  checkAppSource(input);
  if (git(input.agent, 'rev-parse', 'HEAD') !== input.agentSha || git(input.agent, 'rev-parse', 'HEAD^{tree}') !== CURRENT014_GATE3.agent.tree) fail('Agent source identity changed');
  if (git(input.runtime, 'rev-parse', 'HEAD') !== input.runtimeSha || git(input.runtime, 'rev-parse', 'HEAD^{tree}') !== CURRENT014_GATE3.runtime.tree) fail('Runtime source identity changed');
  if (git(input.runtimeProducer, 'rev-parse', 'HEAD') !== CURRENT014_GATE3.runtime.commit || git(input.runtimeProducer, 'rev-parse', 'HEAD^{tree}') !== CURRENT014_GATE3.runtime.tree) fail('Runtime producer source identity changed');
  for (const [root, label] of [[input.agent, 'Agent'], [input.runtime, 'Runtime'], [input.runtimeProducer, 'Runtime producer']]) checkClean(root, label);
  checkVendor(input);
  checkRuntimeLock(input.app, 'App', input.runtimeProducer);
  checkRuntimeLock(input.agent, 'Agent', input.runtimeProducer, input.agentPython);
  checkMetadata(input.app, 'App', APP_METADATA);
  checkMetadata(input.agent, 'Agent', AGENT_METADATA);
  checkRuntimeProducerManifest(input.runtimeProducer, input.runtimePython);
  const appComposition = checkCompositionArchive(input.app, 'App', 'vendor/artifacts');
  checkCompositionArchive(input.agent, 'Agent', 'remotion/artifacts');
  checkCompositionPackage(input.app);
  const graph = checkGraphBytes(input, path.join(input.app, 'vendor/artifacts', CURRENT014_GATE3.composition.archive));
  const testSource = readFileSync(path.join(input.app, TEST_SOURCE), 'utf8');
  const selectedCases = [...testSource.matchAll(/nativeNoneTest\('([^']+)'/g)].map((match) => match[1]);
  if (selectedCases.filter((title) => title === CASE_FULL_TITLE).length !== 1 || !testSource.includes('expectFreshPreviewUnavailable')) {
    fail('Gate3 test path no longer contains the existing native-None unavailable-preview case');
  }
  return Object.freeze({
    appTree: input.appTree, appSha: input.appSha, agent: CURRENT014_GATE3.agent,
    runtime: CURRENT014_GATE3.runtime, vendor: CURRENT014_GATE3.vendor,
    composition: { ...CURRENT014_GATE3.composition, ...appComposition },
    graph, bytes: sourceBytes(input),
  });
}

const ZERO_TEST_OUTPUT = /(?:No tests found|No test files found|collected\s+0 items|Running\s+0 tests|0 tests found|\b0 passed\b)/i;
const PLAYWRIGHT_RESULT_LINE = /^\s*(?<status>[✓✘×-])\s+\d+\s+(?<location>.+)\s+›\s+(?<title>.+?)\s+\([^()\r\n]*\)\s*$/gm;

function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function executorResults(output) {
  return [...output.matchAll(PLAYWRIGHT_RESULT_LINE)].map(({ groups }) => groups);
}

function listedEntries(output) {
  return output.split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line.includes(' › '))
    .map((line) => {
      const separator = line.indexOf(' › ');
      return {
        location: line.slice(0, separator),
        title: line.slice(separator + 3),
      };
    });
}

function listedTitleLines(output) {
  return output.split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line.includes(' › '));
}

export function assertCurrent014Gate3Selection(status, output) {
  if (status !== 0 || ZERO_TEST_OUTPUT.test(output)) fail('Gate3 --list selection did not succeed');
  const entries = listedEntries(output);
  const selected = entries.filter(({ location, title }) => location.startsWith(`${path.basename(TEST_SOURCE)}:`)
    && title === CASE_FULL_TITLE);
  if (selected.length !== 1 || entries.length !== 1) {
    fail(`Gate3 --list selected ${entries.length} tests; expected exactly ${CASE_FULL_TITLE}`);
  }
}

export function assertCurrent014Gate3Result(status, output) {
  if (ZERO_TEST_OUTPUT.test(output)) fail('Gate3 executor reported a zero-test result');
  if (status !== 0) return;

  const results = executorResults(output);
  if (results.length !== 1) {
    fail(`Gate3 executor reported ${results.length} actual test results; expected exactly one`);
  }
  const [result] = results;
  const expectedLocation = new RegExp(`(?:^|›\\s*)${escapeRegExp(TEST_SOURCE)}:\\d+:\\d+$`);
  if (result.status !== '✓' || !expectedLocation.test(result.location) || result.title !== CASE_FULL_TITLE) {
    fail('Gate3 executor did not report exactly the selected native-None single case');
  }
  if (!/\b1 passed\b/i.test(output) || /\b(?:[2-9]\d*|\d{2,}) passed\b/i.test(output)) {
    fail('Gate3 executor did not report exactly one passing test');
  }
  if (/\bexpected[-\s]+(?:failure|fail(?:ed|ure)?)\b/i.test(output)) {
    fail('Gate3 executor reported an expected-failure result');
  }
  if (/\b(?:FAIL|FAILED)\b/i.test(output)) fail('Gate3 executor reported a test failure');
}

function childEnv(input) {
  return {
    ...process.env,
    ASTRID_CHECKOUT: input.agent,
    ASTRID_RUNTIME_CHECKOUT: input.runtime,
    ASTRID_PYTHON: input.agentPython,
    ASTRID_RUNTIME_PYTHON: input.runtimePython,
    TIMELINE_BUNDLE_AGENT_HEAD: input.agentSha,
    TIMELINE_BUNDLE_RUNTIME_HEAD: input.runtimeSha,
    VITE_TIMELINE_COMPOSITION_ROOT: path.join(input.graph, '@banodoco/timeline-composition'),
  };
}

function runCurrent014Gate3Selection(input) {
  const child = spawnSync(CURRENT014_GATE3_CASE.command, [...CURRENT014_GATE3_CASE.argv, '--list'], {
    cwd: input.app,
    env: childEnv(input),
    stdio: ['ignore', 'pipe', 'pipe'], shell: false,
  });
  if (child.error) throw child.error;
  const output = `${child.stdout?.toString() ?? ''}${child.stderr?.toString() ?? ''}`;
  assertCurrent014Gate3Selection(child.status ?? 1, output);
  console.log('[current014/gate3] selection', JSON.stringify({
    argv: CURRENT014_GATE3.argv,
    listArgv: [...CURRENT014_GATE3_CASE.argv, '--list'],
    cwd: input.app,
    config: path.join(input.app, CURRENT014_GATE3_CASE.config),
    testDir: CURRENT014_GATE3_CASE.testDir,
    testMatch: CURRENT014_GATE3_CASE.testMatch,
    grep: CURRENT014_GATE3_CASE.grep,
    fullTitle: listedTitleLines(output)[0],
  }));
}

export function runCurrent014Gate3() {
  if (process.env.TIMELINE_CURRENT014_GATE3_RUN !== '1'
    || process.env.TIMELINE_CURRENT014_GATE3_MANAGER_APPROVED !== '1'
    || process.env.TIMELINE_CURRENT014_GATE3_CURRENT_FULL_TERMINAL !== '1') {
    fail('set the manager-approved run and current-full-terminal gates before invoking Gate3');
  }
  if (process.argv.length !== 2) fail('Gate3 wrapper accepts no caller argv; its single-case argv is fixed');
  const input = readCurrent014Gate3Inputs();
  const before = checkCurrent014Gate3Sources(input);
  console.log('[current014/gate3] source preflight passed; caller is M2 native None single');
  let status = 1;
  try {
    runCurrent014Gate3Selection(input);
    const child = spawnSync(CURRENT014_GATE3_CASE.command, CURRENT014_GATE3_CASE.argv, {
      cwd: input.app,
      env: childEnv(input),
      stdio: ['ignore', 'pipe', 'pipe'], shell: false,
    });
    if (child.error) throw child.error;
    const output = `${child.stdout?.toString() ?? ''}${child.stderr?.toString() ?? ''}`;
    process.stdout.write(output);
    assertCurrent014Gate3Result(child.status ?? 1, output);
    status = child.status ?? 1;
  } finally {
    const after = checkCurrent014Gate3Sources(input);
    if (JSON.stringify(after) !== JSON.stringify(before)) fail('current014 Gate3 source or dependency bytes changed during the browser gate');
    console.log('[current014/gate3] source postflight passed');
  }
  process.exitCode = status;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) runCurrent014Gate3();
