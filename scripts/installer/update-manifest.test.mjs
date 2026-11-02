import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { execFile, execFileSync } from 'node:child_process';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import { test } from 'node:test';

const execute = promisify(execFile);
const repo = path.resolve(import.meta.dirname, '../..');
const tool = path.join(repo, 'scripts/installer/update-manifest.mjs');
const appMetadata = path.join(repo, 'src/integrations/runtime/generated-contract-metadata.ts');

const revision = 'd'.repeat(40);
const repository = 'https://github.com/banodoco/VibeComfy.git';

async function createCheckout(root, name, schemaDigest, runtimeSha) {
  const checkout = path.join(root, name);
  await mkdir(path.join(checkout, 'packages/typescript/src'), { recursive: true });
  await writeFile(path.join(checkout, 'packages/typescript/src/contract-metadata.ts'), `export const SCHEMA_DIGEST = "${schemaDigest}";\n`, 'utf8');
  if (runtimeSha) {
    const put = async (name, value) => {
      const file = path.join(checkout, 'astrid', name);
      await mkdir(path.dirname(file), { recursive: true });
      const bytes = Buffer.from(JSON.stringify(value));
      await writeFile(file, bytes);
      return { path: name, sha256: createHash('sha256').update(bytes).digest('hex') };
    };
    const pins = { schema: 'astrid.engine-pins.v1', sources: { vibecomfy: { repository, revision } } };
    const pinsRef = await put('packs/runpod/pins.json', pins);
    await put('packs/vibecomfy/pins.json', pins);
    const recipe = { schema: 'astrid.engine-recipe.v1', engine: 'vibecomfy', platform: 'windows-x86_64-cu130', pins: pinsRef, source_bindings: [{ name: 'vibecomfy', pin: 'vibecomfy' }] };
    const recipeRef = await put('packs/vibecomfy/recipe.json', recipe);
    await put('packs/engine-index.json', { schema: 'astrid.engine-index.v1', entries: [{ engine: 'vibecomfy', platform: 'windows-x86_64-cu130', recipe: recipeRef }] });
    await writeFile(path.join(checkout, 'runtime.lock.json'), JSON.stringify({ source_commit: runtimeSha }));
  }
  execFileSync('git', ['init', '--quiet'], { cwd: checkout });
  execFileSync('git', ['config', 'user.name', 'Manifest tool test'], { cwd: checkout });
  execFileSync('git', ['config', 'user.email', 'manifest-tool-test@example.invalid'], { cwd: checkout });
  execFileSync('git', ['add', '.'], { cwd: checkout });
  execFileSync('git', ['commit', '--quiet', '-m', 'manifest tool fixture'], { cwd: checkout });
  return checkout;
}

function generatedSchemaDigest(source) {
  const match = source.match(/export const SCHEMA_DIGEST\s*=\s*["']([^"']+)["']/);
  assert.ok(match, 'App generated metadata must declare SCHEMA_DIGEST');
  return match[1];
}

test('plans and writes Runtime/Agent SHAs with the App-generated schema digest', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'astrid-manifest-tool-'));
  try {
    const digest = generatedSchemaDigest(await readFile(appMetadata, 'utf8'));
    const runtime = await createCheckout(root, 'runtime', digest);
    const runtimeSha = execFileSync('git', ['-C', runtime, 'rev-parse', 'HEAD'], { encoding: 'utf8' }).trim();
    const agent = await createCheckout(root, 'agent', digest, runtimeSha);
    const agentSha = execFileSync('git', ['-C', agent, 'rev-parse', 'HEAD'], { encoding: 'utf8' }).trim();
    const manifestPath = path.join(root, 'install-manifest.json');
    const lockPath = path.join(root, 'runtime.lock.json');
    await writeFile(manifestPath, JSON.stringify({ schema_version: 1, agent: { sha: 'a'.repeat(40) }, runtime: { sha: 'b'.repeat(40), schema_digest: 'sha256:' + '0'.repeat(64) }, tools: { uv: { version: 'test' } } }, null, 2) + '\n');
    await writeFile(lockPath, JSON.stringify({ source_commit: runtimeSha }) + '\n');

    const common = ['--runtime-checkout', runtime, '--agent-checkout', agent, '--manifest', manifestPath, '--runtime-lock', lockPath, '--app-metadata', appMetadata];
    const planned = await execute(process.execPath, [tool, ...common, '--plan'], { cwd: repo });
    const plan = JSON.parse(planned.stdout);
    assert.equal(plan.mode, 'plan');
    assert.deepEqual(plan.pins, { runtime_sha: runtimeSha, agent_sha: agentSha, schema_digest: digest, vibecomfy: { sha: revision } });
    assert.equal(JSON.parse(await readFile(manifestPath, 'utf8')).runtime.sha, 'b'.repeat(40));

    await execute(process.execPath, [tool, ...common, '--write'], { cwd: repo });
    const written = JSON.parse(await readFile(manifestPath, 'utf8'));
    assert.deepEqual(written.vibecomfy, { sha: revision });
    assert.equal(written.agent.sha, agentSha);
    assert.equal(written.runtime.sha, runtimeSha);
    assert.equal(written.runtime.schema_digest, digest);
    assert.deepEqual(written.tools, { uv: { version: 'test' } });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('refuses a Runtime checkout whose generated schema digest is not App-compatible', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'astrid-manifest-tool-'));
  try {
    const runtime = await createCheckout(root, 'runtime', 'sha256:' + '1'.repeat(64));
    const runtimeSha = execFileSync('git', ['-C', runtime, 'rev-parse', 'HEAD'], { encoding: 'utf8' }).trim();
    const agent = await createCheckout(root, 'agent', 'sha256:' + '1'.repeat(64), runtimeSha);
    const manifestPath = path.join(root, 'install-manifest.json');
    const lockPath = path.join(root, 'runtime.lock.json');
    const original = JSON.stringify({ schema_version: 1, agent: { sha: 'a'.repeat(40) }, runtime: { sha: 'b'.repeat(40), schema_digest: 'sha256:' + '0'.repeat(64) } }, null, 2) + '\n';
    await writeFile(manifestPath, original);
    await writeFile(lockPath, JSON.stringify({ source_commit: runtimeSha }) + '\n');
    const result = await execute(process.execPath, [tool, '--runtime-checkout', runtime, '--agent-checkout', agent, '--manifest', manifestPath, '--runtime-lock', lockPath, '--app-metadata', appMetadata, '--plan'], { cwd: repo }).then(() => null, error => error);
    assert.equal(result.code, 1);
    assert.match(result.stderr, /schema digest .* does not match App generated schema/);
    assert.equal(await readFile(manifestPath, 'utf8'), original);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('reads Agent pins from the committed head and refuses a foreign Runtime lock', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'astrid-manifest-identity-'));
  try {
    const digest = generatedSchemaDigest(await readFile(appMetadata, 'utf8'));
    const runtime = await createCheckout(root, 'runtime', digest);
    const runtimeSha = execFileSync('git', ['-C', runtime, 'rev-parse', 'HEAD'], { encoding: 'utf8' }).trim();
    const agent = await createCheckout(root, 'agent', digest, runtimeSha);
    const manifestPath = path.join(root, 'manifest.json');
    const lockPath = path.join(root, 'lock.json');
    const original = JSON.stringify({ agent: {}, runtime: {} });
    await writeFile(manifestPath, original);
    await writeFile(lockPath, JSON.stringify({ source_commit: runtimeSha }));
    const args = ['--runtime-checkout', runtime, '--agent-checkout', agent, '--manifest', manifestPath, '--runtime-lock', lockPath, '--app-metadata', appMetadata];
    await writeFile(path.join(agent, 'astrid/packs/vibecomfy/pins.json'), '{}');
    const plan = JSON.parse((await execute(process.execPath, [tool, ...args, '--plan'], { cwd: repo })).stdout);
    assert.deepEqual(plan.pins.vibecomfy, { sha: revision });
    await writeFile(path.join(agent, 'runtime.lock.json'), JSON.stringify({ source_commit: 'f'.repeat(40) }));
    execFileSync('git', ['add', 'runtime.lock.json'], { cwd: agent });
    execFileSync('git', ['commit', '--quiet', '-m', 'foreign runtime'], { cwd: agent });
    await assert.rejects(execute(process.execPath, [tool, ...args, '--write'], { cwd: repo }), /Agent runtime.lock.json source_commit/);
    assert.equal(await readFile(manifestPath, 'utf8'), original);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
