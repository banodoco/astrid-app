import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import { branch, fixture, inventory, put } from './release-fixture.mjs';

for (const [name, options, busy] of [
  ['stored door overrides stale saved port', { savedPorts: '2400,17500,17501' }, []],
  ['stored door survives missing ports file', { savedPorts: null }, []],
  ['stored door survives occupied editor port', {}, [2400]],
  ['stopped unchanged update reuses installed door', {}, []],
]) {
  test(`RB-2: ${name}`, (t) => {
    const f = fixture(t, options);
    f.config.busy = busy; f.writeConfig();
    const r = f.run(name.startsWith('stopped') ? 'update' : 'up');
    assert.match(r.output, /installed program already matches/);
    assert.match(r.output, /fixture: Runtime handoff reached/, 'fixture must reach the unchanged Runtime handoff');
    assert.equal(r.status, 1, 'fixture Runtime deliberately refuses; no real stack starts');
    assert.deepEqual(f.events(), [], 'matching installation must never call installer');
    assert.equal(readFileSync(path.join(f.root, 'state/ports'), 'utf8').trim().split(',')[2], '19501');
  });
}

test('RB-2: running unchanged update logs match and leaves files/process untouched', async (t) => {
  const f = fixture(t);
  const alive = await f.startProcess();
  const before = inventory(f.root);
  const r = f.run('update');
  assert.equal(r.status, 0, r.output);
  assert.match(r.output, /installed program already matches/);
  assert.match(r.output, /Nothing changed/);
  assert.deepEqual(f.events(), []);
  assert.deepEqual(inventory(f.root), before);
  assert.equal(alive(), true);
});

for (const component of ['Agent', 'Runtime']) {
  test(`RB-8: moved ${component} pin refuses before changing any file or process`, async (t) => {
    const f = fixture(t);
    const alive = await f.startProcess();
    f.config.agent = 'b'.repeat(40);
    if (component === 'Runtime') f.config.runtime = 'f'.repeat(40);
    f.writeConfig();
    const before = inventory(f.root);
    const r = f.run('update');
    assert.notEqual(r.status, 0);
    assert.match(r.output, /manifest changed/);
    assert.ok(r.output.includes(`1) astrid-release stop ${branch}`), r.output);
    assert.ok(r.output.includes(`2) keep the data: cp -c -R ${path.join(f.root, 'data')}`), r.output);
    assert.ok(r.output.includes(`3) delete ${f.root} and run astrid-release ${branch} again`), r.output);
    assert.deepEqual(f.events(), []);
    assert.equal(alive(), true, 'refusal must leave the original process alive');
    assert.deepEqual(inventory(f.root), before, 'refusal must preserve the complete file list and file bytes, including editor .git');
  });
}

test('RB-8: first-run network retry removes partial program and data together', (t) => {
  const f = fixture(t, { installed: false, realm: false, installer: 'retry' });
  const r = f.run();
  assert.notEqual(r.status, 0, 'second fixture installer deliberately fails');
  assert.match(r.output, /retrying/);
  const calls = f.events();
  assert.equal(calls.length, 2, r.output);
  assert.equal(calls[1].program, false, 'partial program must be removed before retry');
  assert.equal(calls[1].data, false, 'retained source profile must be removed with partial program');
});

test('RB-8: incomplete first install clears program and data as a pair', (t) => {
  const f = fixture(t, { installed: false, realm: false });
  put(path.join(f.root, 'program/partial'), 'partial program');
  put(path.join(f.root, 'data/runtime/source-profiles/astrid.json'), '{}');
  const r = f.run();
  assert.notEqual(r.status, 0);
  const calls = f.events();
  assert.equal(calls.length, 1, r.output);
  assert.equal(calls[0].program, false);
  assert.equal(calls[0].data, false);
});

for (const command of ['up', 'update']) {
  test(`RB-8: realm marker forbids cleanup or installer when program is incomplete (${command})`, (t) => {
    const f = fixture(t, { installed: false, realm: true, installer: 'retry' });
    put(path.join(f.root, 'program/partial'), 'do not delete');
    put(path.join(f.root, 'data/runtime/source-profiles/astrid.json'), '{}');
    const before = inventory(f.root);
    const r = f.run(command);
    assert.notEqual(r.status, 0);
    assert.match(r.output, /realm copy|realm-id/);
    assert.deepEqual(f.events(), []);
    assert.equal(existsSync(path.join(f.root, 'program/partial')), true);
    assert.deepEqual(inventory(f.root), before);
  });
}
