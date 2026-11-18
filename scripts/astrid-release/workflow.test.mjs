import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';

test('R8: original macOS command precedes Python setup and one PR-scoped packet proof step', () => {
  const workflow = readFileSync(process.env.RELEASE_WORKFLOW_UNDER_TEST || new URL('../../.github/workflows/test.yml', import.meta.url), 'utf8');
  const job = workflow.split(/^  release-tooling-macos:\n/m)[1]?.split(/^  [A-Za-z][\w-]*:\n/m)[0];
  assert.ok(job, 'existing macOS job must remain');
  const steps = job.split(/^      - /m).slice(1);
  const original = 'run: node --test --test-concurrency=1 --test-reporter=spec --test-reporter-destination=stdout --test-reporter=./scripts/quality/node-skip-guard-reporter.mjs --test-reporter-destination=stdout scripts/release/bounded-command.test.mjs scripts/release/astrid-release-provenance.test.mjs scripts/release/verify-extension-ship.test.mjs';
  const first = steps.findIndex(step => step.split('\n')[0] === original);
  assert.ok(first >= 0, 'original command must be byte-identical');
  const scope = step => {
    const condition = step.match(/^        if: (.+)$/m)?.[1] || '';
    assert.match(condition, /github\.event_name == 'pull_request'/);
    assert.match(condition, /github\.base_ref == 'release\/14\/plan-61'/);
    assert.ok(condition.includes('&&') && !condition.includes('||'), condition);
  };
  for (const [index, step] of steps.entries()) {
    if (step.startsWith('uses: actions/setup-python@')) {
      assert.ok(index > first, 'Python setup must not suppress the original test command');
      scope(step);
    }
  }
  const additions = steps.filter((step, index) => index !== first && /(?:^run:|^        run:)/m.test(step));
  assert.equal(additions.length, 1, 'one added packet test step, not an ongoing extra Node lane');
  const added = additions[0];
  assert.ok(steps.indexOf(added) > first);
  scope(added);
  for (const file of ['scripts/astrid-release/release.test.mjs', 'scripts/astrid-release/workflow.test.mjs', 'scripts/installer/manifest.test.mjs', 'scripts/astrid-release/test-realm-snapshot.sh']) assert.ok(added.includes(file), file);
  assert.match(added, /set -euo pipefail/);
  assert.doesNotMatch(job, /continue-on-error/);
  assert.doesNotMatch(added, /--portable|\|\| true|exit 0|set \+e/);
});
