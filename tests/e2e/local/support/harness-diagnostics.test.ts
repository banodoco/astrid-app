import assert from 'node:assert/strict';
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import test from 'node:test';
import { tmpdir } from 'node:os';
import path from 'node:path';

const fixtureRoot = mkdtempSync(path.join(tmpdir(), 'direct-harness-diagnostics-'));
const runtimeCheckout = path.join(fixtureRoot, 'astrid-runtime');
const agentCheckout = path.join(fixtureRoot, 'astrid-agent');
const distDir = path.join(fixtureRoot, 'dist');
const runtimePython = path.join(runtimeCheckout, '.venv', 'bin', 'python');
const agentPython = path.join(agentCheckout, '.venv', 'bin', 'python');
const distIndex = path.join(distDir, 'index.html');
const emptyPath = path.join(fixtureRoot, 'empty-bin');
mkdirSync(path.dirname(runtimePython), { recursive: true });
mkdirSync(path.dirname(agentPython), { recursive: true });
mkdirSync(distDir, { recursive: true });
mkdirSync(emptyPath, { recursive: true });
writeFileSync(runtimePython, '#!/bin/sh\n');
writeFileSync(agentPython, '#!/bin/sh\n');
writeFileSync(distIndex, '<!doctype html>');
chmodSync(runtimePython, 0o755);
chmodSync(agentPython, 0o755);

const savedEnvironment = new Map(['ASTRID_RUNTIME_CHECKOUT', 'ASTRID_CHECKOUT', 'ASTRID_APP_DIRECT_DIST', 'ASTRID_RUNTIME_PYTHON', 'ASTRID_PYTHON', 'PATH'].map((key) => [key, process.env[key]]));
process.env.ASTRID_RUNTIME_CHECKOUT = runtimeCheckout;
process.env.ASTRID_CHECKOUT = agentCheckout;
process.env.ASTRID_APP_DIRECT_DIST = distDir;
delete process.env.ASTRID_RUNTIME_PYTHON;
delete process.env.ASTRID_PYTHON;

const { DirectHarness, harnessUnavailableReason } = await import('./harness.ts');

function restoreFixture() {
  rmSync(runtimeCheckout, { recursive: true, force: true });
  rmSync(agentCheckout, { recursive: true, force: true });
  mkdirSync(path.dirname(runtimePython), { recursive: true });
  mkdirSync(path.dirname(agentPython), { recursive: true });
  writeFileSync(runtimePython, '#!/bin/sh\n');
  writeFileSync(agentPython, '#!/bin/sh\n');
  chmodSync(runtimePython, 0o755);
  chmodSync(agentPython, 0o755);
  mkdirSync(distDir, { recursive: true });
  writeFileSync(distIndex, '<!doctype html>');
  process.env.PATH = savedEnvironment.get('PATH') ?? '';
  delete process.env.ASTRID_RUNTIME_PYTHON;
  delete process.env.ASTRID_PYTHON;
}

test.after(() => {
  for (const [key, value] of savedEnvironment) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  rmSync(fixtureRoot, { recursive: true, force: true });
});

test('reports every direct-journey prerequisite precisely and keeps the healthy path usable', async () => {
  assert.equal(harnessUnavailableReason(), null, 'healthy Runtime, Agent authoring venv, build and openssl');

  rmSync(agentCheckout, { recursive: true, force: true });
  assert.match(harnessUnavailableReason(), /Agent checkout not found .*ASTRID_CHECKOUT/);
  restoreFixture();

  rmSync(agentCheckout, { recursive: true, force: true });
  writeFileSync(agentCheckout, 'not a checkout');
  assert.match(harnessUnavailableReason(), /Agent checkout is not a directory .*ASTRID_CHECKOUT/);
  restoreFixture();

  rmSync(agentPython);
  assert.match(harnessUnavailableReason(), /Agent authoring venv interpreter not found or not executable .*ASTRID_CHECKOUT.*ASTRID_PYTHON/);
  restoreFixture();

  chmodSync(agentPython, 0o644);
  assert.match(harnessUnavailableReason(), /Agent authoring venv interpreter not found or not executable/);
  restoreFixture();

  process.env.ASTRID_PYTHON = path.join(fixtureRoot, 'missing-authoring-python');
  assert.match(harnessUnavailableReason(), /ASTRID_PYTHON is not an executable file: .*ASTRID_PYTHON/);
  restoreFixture();

  rmSync(runtimePython);
  assert.match(harnessUnavailableReason(), /Runtime venv not found .*ASTRID_RUNTIME_CHECKOUT/);
  restoreFixture();

  process.env.ASTRID_RUNTIME_PYTHON = path.join(fixtureRoot, 'missing-runtime-python');
  assert.match(harnessUnavailableReason(), /ASTRID_RUNTIME_PYTHON is not an executable file/);
  restoreFixture();

  rmSync(distIndex);
  assert.match(harnessUnavailableReason(), /no production build .*run npm run build/);
  restoreFixture();

  process.env.PATH = emptyPath;
  assert.equal(harnessUnavailableReason(), 'openssl is required to make the test certificate');
  restoreFixture();

  const harness = new DirectHarness();
  let stopped = false;
  Object.assign(harness, { stopRuntime: async () => { stopped = true; } });
  await assert.rejects(harness.enableTimelineAuthoring(path.join(fixtureRoot, 'missing-authoring-python')), /ASTRID_PYTHON is not an executable file|authoring venv interpreter/);
  assert.equal(stopped, false, 'invalid authoring Python is rejected before Runtime authoring begins');
});
