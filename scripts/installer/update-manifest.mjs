#!/usr/bin/env node
import { execFileSync } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const SHA = /^[0-9a-f]{40}$/;
const DIGEST = /^sha256:[0-9a-f]{64}$/;

const usage = `Usage:
  node scripts/installer/update-manifest.mjs --runtime-checkout <path> --agent-checkout <path> --plan
  node scripts/installer/update-manifest.mjs --runtime-checkout <path> --agent-checkout <path> --write

Read the real Runtime and Agent checkout heads, verify the Runtime generated schema
matches this App's generated schema, and plan or write the installer pins. The
--write form is the single owner release step after Runtime and Agent are merged.

Options:
  --runtime-checkout <path>  Runtime checkout whose HEAD is being proven
  --agent-checkout <path>    Agent checkout whose HEAD is being proven
  --manifest <path>          Manifest to plan/write (default: public/install-manifest.json)
  --runtime-lock <path>      App Runtime lock (default: runtime.lock.json)
  --app-metadata <path>      App generated metadata (default: src/integrations/runtime/generated-contract-metadata.ts)
  --runtime-metadata <path>  Runtime generated metadata (default: packages/typescript/src/contract-metadata.ts)
  --plan                     Print the proposed pin changes without writing
  --write                    Write the proposed pin changes
  --help                     Show this help
`;

const fail = (message) => {
  console.error(`manifest update refused: ${message}`);
  process.exitCode = 1;
};

function parseArgs(argv) {
  const values = { manifest: 'public/install-manifest.json', runtimeLock: 'runtime.lock.json', appMetadata: 'src/integrations/runtime/generated-contract-metadata.ts', runtimeMetadata: 'packages/typescript/src/contract-metadata.ts' };
  let mode = null;
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === '--help') return { help: true };
    if (argument === '--plan' || argument === '--write') {
      if (mode && mode !== argument.slice(2)) throw new Error('--plan and --write are mutually exclusive');
      mode = argument.slice(2);
      continue;
    }
    const option = {
      '--runtime-checkout': 'runtimeCheckout',
      '--agent-checkout': 'agentCheckout',
      '--manifest': 'manifest',
      '--runtime-lock': 'runtimeLock',
      '--app-metadata': 'appMetadata',
      '--runtime-metadata': 'runtimeMetadata',
    }[argument];
    if (!option) throw new Error(`unknown option ${argument}`);
    const value = argv[index + 1];
    if (!value || value.startsWith('--')) throw new Error(`${argument} needs a path`);
    values[option] = value;
    index += 1;
  }
  if (!mode) throw new Error('choose exactly one of --plan or --write');
  if (!values.runtimeCheckout || !values.agentCheckout) throw new Error('--runtime-checkout and --agent-checkout are required');
  return { ...values, mode };
}

function absolute(value) {
  return path.resolve(ROOT, value);
}

function readJson(file) {
  return JSON.parse(readFileSync(file, 'utf8'));
}

function readSchemaDigest(file, label) {
  const source = readFileSync(file, 'utf8');
  const match = source.match(/export const SCHEMA_DIGEST\s*=\s*["']([^"']+)["']/);
  if (!match || !DIGEST.test(match[1])) throw new Error(`${label} has no valid generated SCHEMA_DIGEST`);
  return match[1];
}

function checkoutHead(checkout, label) {
  let head;
  try {
    head = execFileSync('git', ['-C', checkout, 'rev-parse', 'HEAD'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
  } catch {
    throw new Error(`${label} is not a readable git checkout`);
  }
  if (!SHA.test(head)) throw new Error(`${label} HEAD is not a full commit SHA: ${head || '<empty>'}`);
  return head;
}

function makePlan(options) {
  const manifestPath = absolute(options.manifest);
  const runtimeLockPath = absolute(options.runtimeLock);
  const appMetadataPath = absolute(options.appMetadata);
  const runtimeCheckout = absolute(options.runtimeCheckout);
  const agentCheckout = absolute(options.agentCheckout);
  const runtimeMetadataPath = path.resolve(runtimeCheckout, options.runtimeMetadata);
  const manifest = readJson(manifestPath);
  const runtimeLock = readJson(runtimeLockPath);
  if (!manifest.agent || !manifest.runtime || typeof manifest.agent !== 'object' || typeof manifest.runtime !== 'object') {
    throw new Error(`${options.manifest} has no agent/runtime pin objects`);
  }
  if (typeof runtimeLock.source_commit !== 'string' || !SHA.test(runtimeLock.source_commit)) {
    throw new Error(`${options.runtimeLock} has no full Runtime source_commit`);
  }

  const runtimeSha = checkoutHead(runtimeCheckout, 'Runtime checkout');
  const agentSha = checkoutHead(agentCheckout, 'Agent checkout');
  if (runtimeSha !== runtimeLock.source_commit) {
    throw new Error(`Runtime checkout HEAD ${runtimeSha} does not match App runtime.lock.json source_commit ${runtimeLock.source_commit}`);
  }
  const appSchemaDigest = readSchemaDigest(appMetadataPath, 'App generated metadata');
  const runtimeSchemaDigest = readSchemaDigest(runtimeMetadataPath, 'Runtime generated metadata');
  if (runtimeSchemaDigest !== appSchemaDigest) {
    throw new Error(`Runtime schema digest ${runtimeSchemaDigest} does not match App generated schema ${appSchemaDigest}`);
  }

  const next = structuredClone(manifest);
  next.agent.sha = agentSha;
  next.runtime.sha = runtimeSha;
  next.runtime.schema_digest = appSchemaDigest;
  return {
    manifestPath,
    next,
    runtimeSha,
    agentSha,
    schemaDigest: appSchemaDigest,
    changes: [
      { path: 'agent.sha', from: manifest.agent.sha ?? null, to: agentSha },
      { path: 'runtime.sha', from: manifest.runtime.sha ?? null, to: runtimeSha },
      { path: 'runtime.schema_digest', from: manifest.runtime.schema_digest ?? null, to: appSchemaDigest },
    ],
  };
}

function main(argv) {
  if (argv.includes('--help')) {
    console.log(usage);
    return;
  }
  const options = parseArgs(argv);
  const plan = makePlan(options);
  console.log(JSON.stringify({
    mode: options.mode,
    manifest: path.relative(ROOT, plan.manifestPath),
    pins: { runtime_sha: plan.runtimeSha, agent_sha: plan.agentSha, schema_digest: plan.schemaDigest },
    changes: plan.changes,
  }, null, 2));
  if (options.mode === 'write') writeFileSync(plan.manifestPath, `${JSON.stringify(plan.next, null, 2)}\n`);
}

try {
  main(process.argv.slice(2));
} catch (error) {
  fail(error instanceof Error ? error.message : String(error));
}
