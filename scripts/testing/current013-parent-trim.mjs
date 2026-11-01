#!/usr/bin/env node

import { createHash } from 'node:crypto';
import { execFileSync, spawnSync } from 'node:child_process';
import { accessSync, constants, existsSync, readFileSync, realpathSync, statSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import path from 'node:path';
import { checkCurrent013Sources, readCurrent013Inputs } from './current013-integration.mjs';

export const CURRENT013_PARENT_TRIM_AGENT = '8130a401bf44a518d5a40ae274d398b8c560be55';
export const PUBLIC13_ARCHIVE_SHA256 = '9412ae25c306d5118241f4d631e8eecc6eef9b2fb5a98302d40938e9f6d54738';

function fail(message) { throw new Error(`[current013/parent-trim] ${message}`); }

function required(env, name) {
  const value = env[name]?.trim();
  if (!value) fail(`${name} is required`);
  return value;
}

function verifyPublic13Inputs(input, env = process.env) {
  if (input.agentSha !== CURRENT013_PARENT_TRIM_AGENT) fail(`requires Agent ${CURRENT013_PARENT_TRIM_AGENT}`);
  if (env.ASTRID_APP_DIRECT_DIST) fail('ASTRID_APP_DIRECT_DIST is forbidden');
  if (required(env, 'TIMELINE_CURRENT013_PUBLIC_SOURCE_SHA256') !== PUBLIC13_ARCHIVE_SHA256) {
    fail('public13 Composition source digest is not the approved archive');
  }
  const browser = required(env, 'PLAYWRIGHT_CHROMIUM_EXECUTABLE');
  if (!path.isAbsolute(browser) || !existsSync(browser) || !statSync(browser).isFile()) fail('Chromium executable is not a file');
  try { accessSync(browser, constants.X_OK); } catch { fail('Chromium executable is not executable'); }
  const browsers = required(env, 'PLAYWRIGHT_BROWSERS_PATH');
  if (!path.isAbsolute(browsers) || !existsSync(browsers) || !statSync(browsers).isDirectory()) fail('browser bundle path is not a directory');
  const modules = realpathSync(required(env, 'PRIVATE13_NODE_MODULES'));
  const shared = ['/home/user/work/app/node_modules', path.join(input.app, 'node_modules')]
    .filter((candidate) => existsSync(candidate)).map((candidate) => realpathSync(candidate));
  if (shared.includes(modules)) fail('private13 node_modules resolves to the App shared install');
  const temp = required(env, 'TIMELINE_CURRENT013_SHORT_TMPDIR');
  if (!path.isAbsolute(temp)) fail('short temp directory must be absolute');
  return { browser, browsers, modules, temp };
}

function verifyPublic13Archive(app) {
  const file = path.join(app, 'vendor/artifacts/banodoco-timeline-composition-0.0.13.tgz');
  if (!existsSync(file)) fail(`public13 Composition archive is missing: ${file}`);
  const digest = createHash('sha256').update(readFileSync(file)).digest('hex');
  if (digest !== PUBLIC13_ARCHIVE_SHA256) fail(`public13 Composition archive is ${digest}, expected ${PUBLIC13_ARCHIVE_SHA256}`);
  const members = execFileSync('tar', ['-tzf', file], { encoding: 'utf8' }).trim().split('\n').filter((member) => member && !member.endsWith('/'));
  if (members.length !== 77 || new Set(members).size !== members.length || members.some((member) => !member.startsWith('package/') || member.split('/').includes('..'))) {
    fail('public13 Composition archive must contain exactly 77 safe regular files');
  }
}

export function parentTrimCacheIdentity(input) {
  const hash = (url) => createHash('sha256').update(readFileSync(url)).digest('hex');
  return `parent-trim-tree${input.appTree}-agent${input.agentSha}-runtime${input.runtimeSha}-public13-${PUBLIC13_ARCHIVE_SHA256}-runner${hash(new URL(import.meta.url))}-helper${hash(new URL('./current013-integration.mjs', import.meta.url))}`;
}

export function runCurrent013ParentTrim() {
  if (process.env.TIMELINE_CURRENT013_RUN !== '1') fail('set TIMELINE_CURRENT013_RUN=1 only for the manager-approved gate');
  const input = readCurrent013Inputs();
  verifyPublic13Inputs(input);
  verifyPublic13Archive(input.app);
  if (process.env.TIMELINE_CURRENT013_CACHE_ID !== parentTrimCacheIdentity(input)) {
    fail('TIMELINE_CURRENT013_CACHE_ID must identify this exact App tree, Agent/Runtime pair, public13 archive, runner and helper');
  }
  const before = checkCurrent013Sources(input);
  try {
    process.exitCode = spawnSync('npm', ['run', 'test:e2e:three-products', '--', '--config', 'playwright.parent-trim.config.ts'], {
      cwd: input.app,
      env: { ...process.env, ASTRID_CHECKOUT: input.agent, ASTRID_RUNTIME_CHECKOUT: input.runtime,
        ASTRID_PYTHON: input.agentPython, ASTRID_RUNTIME_PYTHON: input.runtimePython,
        TIMELINE_BUNDLE_AGENT_HEAD: input.agentSha, TIMELINE_BUNDLE_RUNTIME_HEAD: input.runtimeSha },
      stdio: 'inherit', shell: false,
    }).status ?? 1;
  } finally {
    const after = checkCurrent013Sources(input);
    if (JSON.stringify(after) !== JSON.stringify(before)) fail('source checks changed during the browser gate');
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) runCurrent013ParentTrim();
