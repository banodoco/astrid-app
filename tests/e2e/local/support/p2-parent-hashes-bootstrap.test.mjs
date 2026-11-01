// Execute the committed popup parent-hash helper against the captured Runtime
// source, with the inherited Python import path removed as in the real launch.
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync, realpathSync } from 'node:fs';
import test from 'node:test';
import { compileFunction } from 'node:vm';
import ts from 'typescript';

const source = readFileSync(new URL('./p2-popup-helpers.ts', import.meta.url), 'utf8');
const helperSource = source.match(/^function authoritativeParentHashes\([^]*?^}/m)?.[0];
assert.ok(helperSource, 'exercise the actual authoritative parent-hash helper');

const astridPython = '/home/user/work/venv-agent/bin/python';
const runtimeCheckout = '/home/user/work/wt/rt-pin-732c48c6';
assert.ok(existsSync(astridPython), `Agent Python missing: ${astridPython}`);
assert.ok(existsSync(runtimeCheckout), `captured Runtime missing: ${runtimeCheckout}`);
assert.equal(realpathSync(runtimeCheckout), runtimeCheckout, 'captured Runtime realpath');
assert.match(
  execFileSync('git', ['-C', runtimeCheckout, 'rev-parse', 'HEAD'], { encoding: 'utf8' }).trim(),
  /^732c48c6/,
  'captured Runtime pin',
);

const authoritativeParentHashes = compileFunction(
  `${ts.transpileModule(helperSource, {}).outputText}\nreturn authoritativeParentHashes;`,
  ['execFileSync', 'ASTRID_PYTHON', 'RUNTIME_CHECKOUT'],
)(execFileSync, astridPython, runtimeCheckout);

const expected = {
  project_id: 'project-5217',
  timeline_id: 'timeline-5217',
  parent_revision: {
    payload: { config: { clips: [{ id: 'clip', at: 1 }] }, marker: 1 },
  },
  dependency_manifest: {
    shots: [{ shot_id: 'shot', revision_id: 'rev', content_digest: 'sha256:shot' }],
    number: 1,
  },
};
const beforeRaw = JSON.stringify({
  payload: { config: { clips: [{ id: 'clip', at: 1.0 }] }, marker: 1.0 },
  dependency_manifest: {
    shots: [{ shot_id: 'shot', revision_id: 'rev', content_digest: 'sha256:shot' }],
    number: 1.0,
  },
});
const expectedHashes = {
  contentDigest: 'sha256:884e03f4ad665d6ea52291cf955db417b733eeda1b2ee346dfbab438566341c5',
  revisionId: 'authoring-parent-revision-0a250bb99c19e856c80ad9c4430e28b3c4565c9faf1ecbb29f50f53be330ca3f',
};

function call(candidate) {
  const inheritedPath = process.env.PYTHONPATH;
  delete process.env.PYTHONPATH;
  try {
    return authoritativeParentHashes(candidate, beforeRaw);
  } finally {
    if (inheritedPath === undefined) delete process.env.PYTHONPATH;
    else process.env.PYTHONPATH = inheritedPath;
  }
}

test('actual parent-hash helper imports only from the captured Runtime pin', () => {
  assert.deepEqual(call(expected), expectedHashes);

  const changedPayload = structuredClone(expected);
  changedPayload.parent_revision.payload.marker = 2;
  const changedHashes = call(changedPayload);
  assert.notEqual(changedHashes.contentDigest, expectedHashes.contentDigest);
  assert.notEqual(changedHashes.revisionId, expectedHashes.revisionId);
  assert.throws(() => assert.deepEqual(changedHashes, expectedHashes));

  assert.throws(() => assert.equal(expectedHashes.contentDigest, 'sha256:wrong-parent-digest'));
  assert.throws(() => assert.equal(expectedHashes.revisionId, 'authoring-parent-revision-wrong'));
});
