import { createHash } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { MOTION_ROOT, MOTION_CONTRACT, MOTION_RELEASE_SOURCE, motionTreeDigest, readMotionAgentSource,
  readMotionFiles, verifyMotionAgentSource, verifyMotionProjection } from './motion-projection.mjs';

test('motion witness binds complete regular tree, not a claim or upstream commit', () => {
  const vendor = fs.mkdtempSync(path.join(os.tmpdir(), 'motion-projection-test-'));
  try {
    const root = path.join(vendor, MOTION_ROOT);
    fs.mkdirSync(root, { recursive: true });
    fs.writeFileSync(path.join(root, 'pack.yaml'), 'source\n');
    const files = readMotionFiles(root);
    const digest = motionTreeDigest(files);
    const fileHash = createHash('sha256').update('source\n').digest('hex');
    assert.equal(digest, createHash('sha256').update('pack.yaml\0' + fileHash + '\n').digest('hex'));
    const commit = 'a'.repeat(40);
    const provenance = { astrid_commit: commit, files: { [MOTION_ROOT + '/pack.yaml']: fileHash } };
    assert.equal(verifyMotionProjection(vendor, provenance), undefined);
    provenance.motion_projection = {
      schema: 'astrid-motion-projection/v1', pack_id: 'astrid_motion',
      repo: 'https://github.com/banodoco/astrid-agent', upstream_subpath: MOTION_ROOT,
      upstream_commit: commit, upstream_tree: 'b'.repeat(40), digest_rule: 'pack-tree-v1',
      upstream_digest: 'c'.repeat(64), alias_only_digest: 'd'.repeat(64), tree_digest: digest, file_count: 1,
    };
    assert.equal(verifyMotionProjection(vendor, provenance), digest);
    assert.throws(() => verifyMotionProjection(vendor, { ...provenance, astrid_commit: 'e'.repeat(40) }), /witness/);
    fs.writeFileSync(path.join(root, 'pack.yaml'), 'changed\n');
    assert.throws(() => verifyMotionProjection(vendor, provenance), /witness/);
    fs.writeFileSync(path.join(root, 'pack.yaml'), 'source\n');
    fs.writeFileSync(path.join(root, 'extra'), 'unrecorded');
    assert.throws(() => verifyMotionProjection(vendor, provenance), /witness/);
    fs.unlinkSync(path.join(root, 'extra'));
    provenance.files[MOTION_ROOT + '/pack.yaml'] = 'f'.repeat(64);
    assert.throws(() => verifyMotionProjection(vendor, provenance), /file hash mismatch/);
  } finally {
    fs.rmSync(vendor, { recursive: true, force: true });
  }
});

const hash = bytes => createHash('sha256').update(bytes).digest('hex');
const gitBlob = bytes => createHash('sha1').update(`blob ${bytes.length}\0`).update(bytes).digest('hex');

function directFixture(run) {
  const vendor = fs.mkdtempSync(path.join(os.tmpdir(), 'direct-motion-test-'));
  const write = (relative, bytes) => {
    fs.mkdirSync(path.dirname(path.join(vendor, relative)), { recursive: true });
    fs.writeFileSync(path.join(vendor, relative), bytes);
  };
  try {
    for (const [name, bytes] of Object.entries({
      'pack.yaml': 'manifest\n',
      'rendering/elements/_shared/am.tsx': 'helper\n',
      'rendering/elements/effects/am-type/element.yaml': 'descriptor\n',
      'rendering/elements/effects/am-type/component.tsx': 'component\n',
    })) write(MOTION_ROOT + '/' + name, bytes);
    const digest = motionTreeDigest(readMotionFiles(path.join(vendor, MOTION_ROOT)));
    const record = {
      schema: 'astrid-motion-release-source/v1', pack_id: 'astrid_motion',
      repo: 'https://github.com/banodoco/poms_packs', upstream_subpath: 'astrid_motion',
      upstream_commit: 'b'.repeat(40), upstream_tree: 'c'.repeat(40), digest_rule: 'pack-tree-v1',
      upstream_digest: digest, tree_digest: digest, file_count: 4, transform: 'identity',
    };
    write(MOTION_CONTRACT, 'export type { ComponentCapabilityContext } from "evaluation";\n');
    write(MOTION_RELEASE_SOURCE, JSON.stringify(record, null, 2) + '\n');
    const all = readMotionFiles(vendor);
    const provenance = {
      astrid_commit: 'a'.repeat(40), motion_projection: record,
      motion_agent_source: {
        schema: 'astrid-motion-agent-source/v1', repo: 'https://github.com/banodoco/astrid-agent',
        commit: 'd'.repeat(40), files: Object.fromEntries([MOTION_CONTRACT, MOTION_RELEASE_SOURCE]
          .map(name => [name, { blob: gitBlob(all.get(name)), sha256: hash(all.get(name)) }])),
      },
      files: Object.fromEntries([...all].map(([name, bytes]) => [name, hash(bytes)])),
    };
    run({ vendor, provenance, digest, write });
  } finally {
    fs.rmSync(vendor, { recursive: true, force: true });
  }
}

test('direct motion keeps distinct pack, Agent contract and baseline origins', () => directFixture(({ vendor, provenance, digest }) => {
  assert.equal(verifyMotionProjection(vendor, provenance), digest);
  assert.notEqual(provenance.astrid_commit, provenance.motion_projection.upstream_commit);
  assert.notEqual(provenance.astrid_commit, verifyMotionAgentSource(vendor, provenance));
  assert.equal(verifyMotionProjection(vendor, { ...provenance, astrid_commit: 'e'.repeat(40) }), digest);
}));

for (const [name, value] of Object.entries({
  schema: 'unknown/v1', pack_id: 'other', repo: 'https://example.com/poms_packs',
  upstream_subpath: '../astrid_motion', upstream_commit: ['b'.repeat(40)], upstream_tree: ['c'.repeat(40)],
  digest_rule: 'other', upstream_digest: 'e'.repeat(64), tree_digest: 'e'.repeat(64),
  file_count: true, transform: 'rewrite', alias_only_digest: 'e'.repeat(64), derived_from: null,
})) {
  test('direct witness refuses invalid field ' + name, () => directFixture(({ vendor, provenance }) => {
    provenance.motion_projection = { ...provenance.motion_projection, [name]: value };
    assert.throws(() => verifyMotionProjection(vendor, provenance), /witness/);
  }));
}

test('direct source commit is checked against independently copied Agent witness', () => directFixture(({ vendor, provenance }) => {
  provenance.motion_projection = { ...provenance.motion_projection, upstream_commit: 'e'.repeat(40) };
  assert.throws(() => verifyMotionProjection(vendor, provenance), /selected Agent witness/);
}));

for (const relative of ['pack.yaml', 'rendering/elements/_shared/am.tsx',
  'rendering/elements/effects/am-type/element.yaml', 'rendering/elements/effects/am-type/component.tsx']) {
  test('direct tree refuses changed ' + relative, () => directFixture(({ vendor, provenance, write }) => {
    write(MOTION_ROOT + '/' + relative, 'changed\n');
    assert.throws(() => verifyMotionProjection(vendor, provenance), /witness/);
  }));
}

for (const relative of [MOTION_CONTRACT, MOTION_RELEASE_SOURCE]) {
  test('direct Agent source refuses changed bytes even with refreshed output hash: ' + relative, () => directFixture(({ vendor, provenance, write }) => {
    write(relative, 'changed\n');
    provenance.files[relative] = hash('changed\n');
    assert.throws(() => verifyMotionProjection(vendor, provenance), /Agent source hash mismatch/);
  }));
  test('direct Agent source refuses symlink: ' + relative, () => directFixture(({ vendor, provenance }) => {
    const file = path.join(vendor, relative);
    fs.renameSync(file, file + '.original');
    fs.symlinkSync(file + '.original', file);
    assert.throws(() => verifyMotionProjection(vendor, provenance), /Non-regular/);
  }));
}

test('direct profile refuses missing and ambiguous source witnesses', () => directFixture(({ vendor, provenance }) => {
  const noSource = { ...provenance }; delete noSource.motion_agent_source;
  assert.throws(() => verifyMotionProjection(vendor, noSource), /Agent source/);
  const noWitness = { ...provenance }; delete noWitness.motion_projection;
  assert.throws(() => verifyMotionProjection(vendor, noWitness), /lacks its witness/);
  const extra = structuredClone(provenance); extra.motion_agent_source.files.other = {};
  assert.throws(() => verifyMotionProjection(vendor, extra), /Agent source/);
}));

test('direct profile refuses extra files, missing provenance and root links', () => directFixture(({ vendor, provenance, write }) => {
  write(MOTION_ROOT + '/unrecorded', 'extra');
  assert.throws(() => verifyMotionProjection(vendor, provenance), /witness/);
  fs.unlinkSync(path.join(vendor, MOTION_ROOT, 'unrecorded'));
  const missing = structuredClone(provenance); delete missing.files[MOTION_ROOT + '/pack.yaml'];
  assert.throws(() => verifyMotionProjection(vendor, missing), /file list/);
  const root = path.join(vendor, MOTION_ROOT);
  fs.renameSync(root, root + '.original'); fs.symlinkSync(root + '.original', root);
  assert.throws(() => verifyMotionProjection(vendor, provenance), /real directory/);
}));

test('selected Agent source is verified against actual immutable Git objects and exact clean HEAD', () => directFixture(({ vendor, provenance }) => {
  const repo = fs.mkdtempSync(path.join(os.tmpdir(), 'motion-agent-source-test-'));
  const git = (...args) => execFileSync('git', ['-C', repo, ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
  try {
    for (const relative of [MOTION_CONTRACT, MOTION_RELEASE_SOURCE]) {
      fs.mkdirSync(path.dirname(path.join(repo, relative)), { recursive: true });
      fs.copyFileSync(path.join(vendor, relative), path.join(repo, relative));
    }
    git('init', '-q'); git('add', '.');
    git('-c', 'user.name=Test', '-c', 'user.email=test@example.invalid', 'commit', '-qm', 'Fixture source');
    const commit = git('rev-parse', 'HEAD');
    const selected = readMotionAgentSource(repo, commit);
    provenance.motion_agent_source = selected.record;
    assert.equal(verifyMotionAgentSource(vendor, provenance, { agentRepo: repo, agentCommit: commit }), commit);
    const changed = structuredClone(provenance); changed.motion_agent_source.commit = 'e'.repeat(40);
    assert.throws(() => verifyMotionAgentSource(vendor, changed, { agentRepo: repo, agentCommit: commit }), /selected Git source/);
    assert.throws(() => readMotionAgentSource(repo, 'e'.repeat(40)), /exact commit/);
    assert.throws(() => readMotionAgentSource(repo), /exact --agent-commit/);
    fs.appendFileSync(path.join(repo, MOTION_CONTRACT), '// changed\n');
    assert.throws(() => readMotionAgentSource(repo, commit), /exact commit/);
  } finally { fs.rmSync(repo, { recursive: true, force: true }); }
}));
