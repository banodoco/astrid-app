import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { mkdtempSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import { test } from 'node:test';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import {
  createD21Environment,
  observeD21Harness,
  observeD21Page,
  persistD21Environment,
  recordD21Error,
  recordD21Readiness,
  serializeD21Environment,
} from './d21-environment.ts';

test('the safe projector does not carry a secret canary from malformed endpoint input', () => {
  const artifact = createD21Environment();
  observeD21Harness(artifact, {
    runtimeUrl: 'http://127.0.0.1:17340/v1?canary=do-not-export',
    doorBase: 'http://127.0.0.1:17340/api/runtime',
    doorPrefix: '/api/runtime',
    editorOrigin: 'https://astrid.test:443',
    productCredentialPresent: true,
    authoringProfile: 'UNKNOWN',
  });
  observeD21Page(artifact, { url: 'not a URL' });
  const text = serializeD21Environment(artifact);
  assert.doesNotMatch(text, /do-not-export|canary/);
  assert.equal(artifact.backend.host.observation, 'UNKNOWN');
  assert.equal(artifact.editor.origin.observation, 'UNKNOWN');
});

test('safe observations retain public endpoint facts and never URL queries', () => {
  const artifact = createD21Environment();
  observeD21Harness(artifact, {
    runtimeUrl: 'http://127.0.0.1:19001',
    doorBase: 'http://127.0.0.1:19002/api/runtime',
    doorPrefix: '/api/runtime',
    editorOrigin: 'https://astrid.test:19003',
    productCredentialPresent: false,
    authoringProfile: 'astrid',
    agentCommit: '079580ca46af77e0292d49dc34386b25c8391f99',
    runtimeCommit: '2a9e347ff0e1df1dedff5ab7b59ddb27dfe3129d',
  });
  observeD21Page(artifact, { url: 'https://astrid.test:19003/tools/video-editor?private=1#fragment' });
  assert.deepEqual(artifact.backend.port, { observation: 'OBSERVED', value: 19001 });
  assert.deepEqual(artifact.door.port, { observation: 'OBSERVED', value: 19002 });
  assert.deepEqual(artifact.editor.path, { observation: 'OBSERVED', value: '/tools/video-editor' });
  assert.equal(artifact.provider.attached.observation, 'UNKNOWN');
  assert.equal(artifact.provider.sourceObserved.observation, 'DECLARED');
  assert.equal(artifact.sourceCommits.launcher.value?.length, 2);
  assert.doesNotMatch(serializeD21Environment(artifact), /private|fragment/);
});

test('lifecycle projection distinguishes declared launch facts from observed process facts', () => {
  const artifact = createD21Environment();
  observeD21Harness(artifact, {
    runtimeUrl: 'http://127.0.0.1:19001',
    doorBase: 'http://127.0.0.1:19002/api/runtime',
    doorPrefix: '/api/runtime',
    editorOrigin: 'https://astrid.test:19003',
    productCredentialPresent: true,
    authoringProfile: 'astrid',
    lifecycle: {
      startedAt: '2026-10-23T20:00:00.000Z',
      readyAt: '2026-10-23T20:00:01.000Z',
      launchInterpreter: '/approved/python',
      launchModule: 'runtime_protocol.cli',
      launchProfile: 'astrid',
      actualInterpreter: '/proc/123/exe',
      actualModule: 'runtime_protocol.cli',
      doorOriginEquality: true,
    },
  });
  assert.deepEqual(artifact.backend.launch.module, { observation: 'DECLARED', value: 'runtime_protocol.cli' });
  assert.deepEqual(artifact.backend.launch.profile, { observation: 'DECLARED', value: 'astrid' });
  assert.deepEqual(artifact.backend.process.module, { observation: 'OBSERVED', value: 'runtime_protocol.cli' });
  assert.deepEqual(artifact.door.allowedOriginEquality, { observation: 'OBSERVED', value: true });
  assert.equal(artifact.provider.attached.observation, 'UNKNOWN');
  assert.doesNotMatch(serializeD21Environment(artifact), /stdout|--root|credential|token/);
});

test('startup failure and observed signal exit remain finite facts', () => {
  const artifact = createD21Environment();
  observeD21Harness(artifact, {
    runtimeUrl: 'http://127.0.0.1:19001',
    doorBase: 'http://127.0.0.1:19002/api/runtime',
    doorPrefix: '/api/runtime',
    editorOrigin: 'https://astrid.test:19003',
    productCredentialPresent: false,
    authoringProfile: 'UNKNOWN',
    lifecycle: {
      startedAt: '2026-10-23T20:00:00.000Z',
      launchInterpreter: '/approved/python',
      launchModule: 'runtime_protocol.cli',
      launchProfile: 'neutral',
      exitCode: null,
      exitedAt: '2026-10-23T20:00:00.500Z',
      failure: { code: 'startup_failed', class: 'startup', stage: 'health' },
    },
  });
  assert.deepEqual(artifact.backend.error, { observation: 'OBSERVED', value: { code: 'startup_failed', class: 'startup', stage: 'health' } });
  assert.deepEqual(artifact.backend.exit, { observation: 'OBSERVED', value: null });
  assert.deepEqual(artifact.backend.exitAt, { observation: 'OBSERVED', value: '2026-10-23T20:00:00.500Z' });
  assert.equal(artifact.backend.process.module.observation, 'UNKNOWN');
});

test('unknown provider and owner observations stay unknown, including a connected-false control', () => {
  const artifact = createD21Environment();
  recordD21Readiness(artifact, false, 'UNKNOWN');
  assert.equal(artifact.readiness.connected.value, false);
  assert.equal(artifact.readiness.freshSettledOwner.observation, 'UNKNOWN');
  assert.equal(artifact.status, 'failed');
  assert.equal(createD21Environment().provider.attached.observation, 'UNKNOWN');
});

test('the bounded serializer rejects oversized output instead of truncating JSON', () => {
  const artifact = createD21Environment();
  artifact.stages.push(...Array.from({ length: 8 }, (_, index) => ({
    name: `stage-${index}`,
    startedAt: '2026-10-23T00:00:00.000Z',
    completedAt: '2026-10-23T00:00:01.000Z',
    result: 'FAILED' as const,
  })));
  artifact.backend.imports.daemon.modules = { observation: 'OBSERVED', value: Array.from({ length: 5000 }, () => 'module') };
  assert.throws(() => serializeD21Environment(artifact), /32KiB/);
});

function filesNamed(root: string, name: string): string[] {
  const found: string[] = [];
  const pending = [root];
  while (pending.length > 0) {
    const current = pending.pop()!;
    for (const entry of readdirSync(current)) {
      const candidate = path.join(current, entry);
      if (statSync(candidate).isDirectory()) pending.push(candidate);
      else if (entry === name) found.push(candidate);
    }
  }
  return found;
}

function runWorkerLifecycleControl(failSetup: boolean): { root: string; result: ReturnType<typeof spawnSync> } {
  const root = mkdtempSync(path.join(process.env.TMPDIR ?? os.tmpdir(), 'd21-workerinfo-'));
  const outputDir = path.join(root, 'results');
  const reportFile = path.join(root, 'report.json');
  const environmentModule = fileURLToPath(new URL('./d21-environment.ts', import.meta.url));
  const playwrightModule = path.join(path.dirname(createRequire(import.meta.url).resolve('@playwright/test')), 'index.mjs');
  writeFileSync(path.join(root, 'worker-lifecycle.spec.ts'), `
import { test as base } from ${JSON.stringify(playwrightModule)};
import { createD21Environment, persistD21Environment, recordD21Error } from ${JSON.stringify(environmentModule)};

const test = base.extend<{ carrier: void }>({
  carrier: [async ({}, use, workerInfo) => {
    const artifact = createD21Environment();
    await persistD21Environment(workerInfo, artifact);
    if (process.env.D21_LIFECYCLE_FAIL === '1') {
      artifact.status = 'failed';
      recordD21Error(artifact, { code: 'controlled_setup_failure', class: 'setup', stage: 'worker' });
      await persistD21Environment(workerInfo, artifact);
      throw new Error('controlled setup failure');
    }
    await use();
  }, { scope: 'worker' }],
});

test('worker carrier reaches the genuine test-info boundary', async ({ carrier }, testInfo) => {
  void carrier;
  await persistD21Environment(testInfo, createD21Environment());
});
`);
  writeFileSync(path.join(root, 'playwright.config.mjs'), `
import { defineConfig } from ${JSON.stringify(playwrightModule)};
export default defineConfig({
  testDir: ${JSON.stringify(root)},
  testMatch: /worker-lifecycle\\.spec\\.ts$/,
  outputDir: ${JSON.stringify(outputDir)},
  reporter: [['json', { outputFile: ${JSON.stringify(reportFile)} }]],
  workers: 1,
  timeout: 10_000,
});
`);
  const result = spawnSync(process.execPath, [
    '--import', 'tsx', path.resolve('node_modules/@playwright/test/cli.js'), 'test',
    '--config', path.join(root, 'playwright.config.mjs'),
  ], {
    cwd: path.resolve('.'),
    env: { ...process.env, D21_LIFECYCLE_FAIL: failSetup ? '1' : '0' },
    encoding: 'utf8',
    timeout: 30_000,
  });
  return { root, result };
}

test('real worker fixture writes an early artifact and preserves controlled setup failure', () => {
  const success = runWorkerLifecycleControl(false);
  assert.equal(success.result.status, 0, `${success.result.stdout}\n${success.result.stderr}`);
  const successArtifacts = filesNamed(success.root, 'd21-environment.json');
  assert.ok(successArtifacts.some((file) => file.includes(`${path.sep}worker-0${path.sep}`)));
  assert.ok(successArtifacts.some((file) => !file.includes(`${path.sep}worker-0${path.sep}`)));
  const earlyPath = successArtifacts.find((file) => file.includes(`${path.sep}worker-0${path.sep}`))!;
  const early = JSON.parse(readFileSync(earlyPath, 'utf8'));
  assert.equal(early.status, 'preflight');
  assert.equal(early.backend.host.observation, 'UNKNOWN');
  assert.equal(statSync(earlyPath).mode & 0o777, 0o600);
  assert.match(readFileSync(path.join(success.root, 'report.json'), 'utf8'), /d21-environment\.json/);

  const failure = runWorkerLifecycleControl(true);
  assert.notEqual(failure.result.status, 0, `${failure.result.stdout}\n${failure.result.stderr}`);
  const failureArtifacts = filesNamed(failure.root, 'd21-environment.json');
  const failedEarlyPath = failureArtifacts.find((file) => file.includes(`${path.sep}worker-0${path.sep}`))!;
  const failedEarly = JSON.parse(readFileSync(failedEarlyPath, 'utf8'));
  assert.equal(failedEarly.status, 'failed');
  assert.deepEqual(failedEarly.backend.error.value, { code: 'controlled_setup_failure', class: 'setup', stage: 'worker' });
  assert.equal(statSync(failedEarlyPath).mode & 0o777, 0o600);
  assert.match(readFileSync(path.join(failure.root, 'report.json'), 'utf8'), /controlled setup failure/);
});
