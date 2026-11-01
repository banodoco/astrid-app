#!/usr/bin/env node

// Compose with the approved current013 guard wrapper before running this lane.
import { spawnSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';
import { checkCurrent013Sources, readCurrent013Inputs } from './current013-integration.mjs';

export function runCurrent013NativeNone() {
  if (process.env.TIMELINE_CURRENT013_RUN !== '1') {
    throw new Error('Supply the manager-approved current013/native None pair before running this lane');
  }
  const input = readCurrent013Inputs();
  const before = checkCurrent013Sources(input);
  try {
    process.exitCode = spawnSync('npm', ['run', 'test:e2e:three-products', '--', '--grep', 'M2 native None'], {
      cwd: input.app,
      env: {
        ...process.env,
        ASTRID_CHECKOUT: input.agent,
        ASTRID_RUNTIME_CHECKOUT: input.runtime,
        ASTRID_PYTHON: input.agentPython,
        ASTRID_RUNTIME_PYTHON: input.runtimePython,
        TIMELINE_BUNDLE_AGENT_HEAD: input.agentSha,
        TIMELINE_BUNDLE_RUNTIME_HEAD: input.runtimeSha,
      },
      stdio: 'inherit',
      shell: false,
    }).status ?? 1;
  } finally {
    const after = checkCurrent013Sources(input);
    if (JSON.stringify(after) !== JSON.stringify(before)) {
      throw new Error('current013/native None sources changed during the browser gate');
    }
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) runCurrent013NativeNone();
