// Pure matcher contract; no spec registration, fixtures, browser or Runtime execution.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { compileFunction } from 'node:vm';
import { expect } from '@playwright/test';
import ts from 'typescript';

const source = readFileSync(new URL('../three-products.spec.ts', import.meta.url), 'utf8');
const helper = source.match(/^function expectTransitionClear\([^]*?^}/m)?.[0];
assert.ok(helper, 'exercise the actual browser assertion helper');
const check = compileFunction(`${ts.transpileModule(helper, {}).outputText}\nreturn expectTransitionClear;`, ['expect'])(expect);
const golden = JSON.parse(readFileSync(new URL('./fixtures/native-parent-transition-clear.json', import.meta.url), 'utf8'));
const base = { revision_id: 'parent-1', publication_id: 'publication-1' };
const original = { [golden.original.id]: golden.original };
const request = () => ({ base_revision_id: base.revision_id, base_publication_id: base.publication_id,
  commands: [structuredClone(golden.command)] });

test('parent clear helper accepts the frozen S2/905 command with only scalar.target', () => {
  assert.deepEqual(golden.command.bindings, { 'scalar.target': golden.command.select });
  check(request(), base, original, [golden.original.id]);
});

test('parent clear helper rejects an invented owner or mismatched target binding', () => {
  for (const bindings of [
    { ...golden.command.bindings, 'scalar.owner': 'parent' },
    { ...golden.command.bindings, 'scalar.owner': undefined },
    { 'scalar.target': 'parent/clip:another-clip' },
    {},
  ]) {
    const changed = request();
    changed.commands[0].bindings = bindings;
    assert.throws(() => check(changed, base, original, [golden.original.id]));
  }
});
