import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { describe, it } from 'node:test';
import {
  MAIN95_AGENT,
  MAIN95_NESTED_COHORT,
  MAIN95_RUNTIME,
  MAIN95_VENDOR,
  buildMain95ChildEnv,
  readMain95Inputs,
  validateMain95NestedCohort,
  validateMain95Vendor,
} from './main95-prompt-settings-integration.mjs';

const provenance = JSON.parse(readFileSync('vendor/astrid-browser/provenance.json', 'utf8'));
const moduleBytes = readFileSync(`vendor/astrid-browser/${MAIN95_VENDOR.module}`);

describe('Main95 prompt/settings source roles', () => {
  it('accepts the independently qualified current vendor role', () => {
    assert.notDeepEqual(MAIN95_VENDOR, MAIN95_AGENT);
    assert.deepEqual(validateMain95Vendor(provenance, moduleBytes), {
      commit: MAIN95_VENDOR.commit,
      tree: MAIN95_VENDOR.tree,
      fileCount: MAIN95_VENDOR.fileCount,
      module: MAIN95_VENDOR.module,
      moduleSha256: MAIN95_VENDOR.moduleSha256,
    });
  });

  it('rejects the frozen execution Agent as the vendor role', () => {
    const wrongRole = structuredClone(provenance);
    wrongRole.astrid_commit = MAIN95_AGENT.commit;
    wrongRole.astrid_tree = MAIN95_AGENT.tree;
    assert.throws(() => validateMain95Vendor(wrongRole, moduleBytes), /independently qualified/);
  });

  it('rejects a vendor module provenance or byte hash change', () => {
    const wrongProvenanceHash = structuredClone(provenance);
    wrongProvenanceHash.files[MAIN95_VENDOR.module] = '0'.repeat(64);
    assert.throws(() => validateMain95Vendor(wrongProvenanceHash, moduleBytes), /module provenance hash/);
    assert.throws(() => validateMain95Vendor(provenance, Buffer.concat([moduleBytes, Buffer.from('\n')])), /module bytes changed/);
  });
});

describe('Main95 prompt/settings nested cohort preflight', () => {
  const exactRootInputs = {
    TIMELINE_MAIN95_PROMPT_APP_TREE: 'a'.repeat(40),
    TIMELINE_MAIN95_PROMPT_AGENT_SHA: MAIN95_AGENT.commit,
    TIMELINE_MAIN95_PROMPT_RUNTIME_SHA: MAIN95_RUNTIME.commit,
    TIMELINE_MAIN95_PROMPT_RUNNER_SHA256: `sha256:${'b'.repeat(64)}`,
  };

  it('rejects every missing or stale nested value in root preflight before discovery/browser', () => {
    for (const name of Object.keys(MAIN95_NESTED_COHORT)) {
      const missing = { ...MAIN95_NESTED_COHORT };
      delete missing[name];
      assert.throws(() => readMain95Inputs({ ...exactRootInputs, ...missing }), new RegExp(`${name} is required`));

      const stale = { ...MAIN95_NESTED_COHORT, [name]: 'stale' };
      assert.throws(() => readMain95Inputs({ ...exactRootInputs, ...stale }), new RegExp(`${name} must match`));
    }
  });

  it('accepts the exact tuple and forwards the same values to the child environment', () => {
    const validated = validateMain95NestedCohort({ ...MAIN95_NESTED_COHORT });
    const childEnv = buildMain95ChildEnv({
      ...exactRootInputs,
      env: { ...validated },
      agent: '/agent',
      runtime: '/runtime',
      agentPython: '/agent/python',
      runtimePython: '/runtime/python',
      agentSha: MAIN95_AGENT.commit,
      runtimeSha: exactRootInputs.TIMELINE_MAIN95_PROMPT_RUNTIME_SHA,
      nestedCohort: validated,
    }, '/tmp/main95-child-test');
    assert.deepEqual(validated, MAIN95_NESTED_COHORT);
    assert.deepEqual(
      Object.fromEntries(Object.keys(MAIN95_NESTED_COHORT).map((name) => [name, childEnv[name]])),
      MAIN95_NESTED_COHORT,
    );
  });
});
