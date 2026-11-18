import { after, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { checkKnownFailures } from './check-known-failures.mjs';
import { inspectTestSource } from './lib/test-source.mjs';

const roots = [];
after(() => roots.forEach((root) => rmSync(root, { recursive: true, force: true })));
function fixture(file, source) {
  const root = mkdtempSync(path.join(os.tmpdir(), 'p39-test-source-'));
  roots.push(root);
  mkdirSync(path.dirname(path.join(root, file)), { recursive: true });
  writeFileSync(path.join(root, file), source);
  return root;
}

const probes = [
  ['multiline member', 'src/a.test.ts', "it\n  .fails('case', () => {});"],
  ['concurrent modifier', 'src/a.test.ts', "test.concurrent.fails('case', () => {});"],
  ['bracket member', 'src/a.test.ts', "it['fails']('case', () => {});"],
  ['computed constant member', 'src/a.test.ts', "it['fa' + 'ils']('case', () => {});"],
  ['renamed import', 'src/a.test.ts', "import { test as check } from 'vitest'; check.fails('case', () => {});"],
  ['assigned test alias', 'src/a.test.ts', "const check = it; check.fails('case', () => {});"],
  ['assigned fails alias', 'src/a.test.ts', "const check = it.fails; check('case', () => {});"],
  ['destructured fails alias', 'src/a.test.ts', "const { fails: check } = it; check('case', () => {});"],
  ['namespace import', 'src/a.test.ts', "import * as v from 'vitest'; v.it.fails('case', () => {});"],
  ['each builder', 'src/a.test.ts', "test.fails.each([1, 2])('case %s', () => {});"],
  ['JavaScript include', 'src/a.test.js', "it.fails('case', () => {});"],
  ['JSX include', 'src/a.test.jsx', "it.fails('case', () => {});"],
  ['edge function include', 'supabase/functions/feature/a.test.ts', "it.fails('case', () => {});"],
  ['config include', 'config/vite/a.test.ts', "it.fails('case', () => {});"],
];

describe('TypeScript AST expected-failure gate', () => {
  for (const [name, file, source] of probes) {
    it(`rejects ${name}`, () => {
      const result = checkKnownFailures({ repoRoot: fixture(file, source) });
      assert.equal(result.forbiddenEntries.length, 1);
      assert.match(result.problems.join('\n'), /expected-failure markers are forbidden/);
    });
  }
  it('uses a supplied runner include glob outside the old scan directories', () => {
    const result = checkKnownFailures({ repoRoot: fixture('other/a.test.js', "it.fails('case', () => {});"), include: ['other/**/*.test.js'] });
    assert.equal(result.forbiddenEntries.length, 1);
  });
  it('does not mistake quoted source or comments for executable markers', () => {
    const result = checkKnownFailures({ repoRoot: fixture('src/a.test.ts', `
      // it.fails('comment', () => {});
      const example = "it.fails('quoted', () => {})";
      it('real', () => {});
    `) });
    assert.deepEqual(result.problems, []);
  });
  it('keeps a Playwright step inside its owning test', () => {
    const markers = inspectTestSource('/probe.test.ts', `import { test } from '@playwright/test';
      test('parent', async () => { await test.step('step', async () => { test.fail(true, 'reason'); }); });`).expectedFailures;
    assert.equal(markers[0].title, 'parent');
  });
  it('binds the helper to the defining test, including a renamed helper', () => {
    const helper = new URL('../../src/test/declaredSkip.ts', import.meta.url).pathname;
    const source = `import { it } from 'vitest';\nimport { skipWhen as declared } from '${helper}';\nit('bound', (ctx) => { declared('direct-journey-harness', ctx); });\nit('unbound', (ctx) => {});`;
    const parsed = inspectTestSource('/probe.test.ts', source);
    assert.deepEqual(parsed.declaredSkipsAt({ line: 3, column: 1 }), ['direct-journey-harness']);
    assert.deepEqual(parsed.declaredSkipsAt({ line: 4, column: 1 }), []);
    assert.deepEqual(parsed.declaredSkipsAt(undefined), []);
  });
  it('does not treat a shadowed or counterfeit helper as authorization', () => {
    const parsed = inspectTestSource('/probe.test.ts', `import { it } from 'vitest';
      import { skipWhen } from './counterfeit/declaredSkip';
      it('unbound', (ctx) => { skipWhen('direct-journey-harness', ctx); });`);
    assert.deepEqual(parsed.declaredSkipsAt({ line: 3, column: 7 }), []);
  });
});
