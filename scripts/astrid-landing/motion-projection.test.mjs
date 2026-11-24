import { createHash } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { MOTION_ROOT, motionTreeDigest, readMotionFiles, verifyMotionProjection } from './motion-projection.mjs';

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
