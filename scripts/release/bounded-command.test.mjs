import { strict as assert } from 'node:assert';
import { execFileSync, spawn } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { describe, it } from 'node:test';
import { Worker } from 'node:worker_threads';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { declaredSkip } from '../quality/declared-skip.mjs';

import {
  BoundedCommandError,
  runBoundedCommand,
} from './bounded-command.mjs';
import {
  PROCESS_SCOPE_CLEANUP_ALLOWANCE_MS,
  PROCESS_SCOPE_MAX_DRAIN_ATTEMPTS,
  PROCESS_SCOPE_POLL_MS,
  PROCESS_SCOPE_SCAN_RETRIES,
  PROCESS_SCOPE_SCAN_TIMEOUT_MS,
  PROCESS_SCOPE_SINGLE_SCAN_BUDGET_MS,
  inspectBrokerOwner,
  retryProcessScan,
} from './bounded-command-scan-policy.mjs';

const NODE = process.execPath;
// Cases that expect success bound only a hang: the commands exit at once, and a slow runner (or twenty starting together) must not turn
// them into timeouts. Cases whose subject is the timeout pass their own short bound.
const HANG_GUARD_MS = 120_000;
const BASE = Object.freeze({ timeoutMs: HANG_GUARD_MS, maxBuffer: 64 * 1024, killSignal: 'SIGKILL' });

function run(source, options = {}) {
  return runBoundedCommand(NODE, ['-e', source], { ...BASE, ...options });
}

function processState(pid) {
  try {
    return execFileSync('/bin/ps', ['-p', String(pid), '-o', 'stat='], { encoding: 'utf8' }).trim();
  } catch (error) {
    if (error?.status === 1) return '';
    throw error;
  }
}

// The broker and process-scope containment run on macOS (lockf, ps eww); see `macos-release-process-containment`.
// The cases that need no broker still run everywhere.
describe('runBoundedCommand', () => {
  it('keeps an unavailable broker owner scan fail-closed instead of deleting artifacts', () => {
    assert.deepEqual(inspectBrokerOwner(null, 42, 1_700_000_000), {
      status: 'unknown',
      row: null,
    });
    assert.equal(inspectBrokerOwner([], 42, 1_700_000_000).status, 'dead');
    assert.equal(
      inspectBrokerOwner([
        { pid: 42, start: new Date(1_700_000_000 * 1_000).toString() },
      ], 42, 1_700_000_000).status,
      'alive',
    );
  });

  it('recovers transient process-scan timeouts before poisoning the shared broker', async () => {
    const failures = [new Error('ps eww timed out after 1000ms'), new Error('ps eww timed out after 1000ms')];
    const waits = [];
    let calls = 0;
    const rows = await retryProcessScan(
      async () => {
        const failure = failures[calls];
        calls += 1;
        if (failure) throw failure;
        return [{ pid: 42 }];
      },
      {
        attempts: 3,
        delayMs: 40,
        wait: async (milliseconds) => { waits.push(milliseconds); },
      },
    );

    assert.deepEqual(rows, [{ pid: 42 }]);
    assert.equal(calls, 3);
    assert.deepEqual(waits, [40, 40]);
  });

  it('still fails closed after the complete process-scan retry budget', async () => {
    let calls = 0;
    await assert.rejects(
      retryProcessScan(
        async () => {
          calls += 1;
          throw new Error(`scan failure ${calls}`);
        },
        { attempts: 3, delayMs: 0, wait: async () => {} },
      ),
      (error) => {
        assert.equal(error.code, 'EPSCAN');
        assert.match(error.message, /process scan failed after 3 attempts: scan failure 3/);
        return true;
      },
    );
    assert.equal(calls, 3);
  });

  it('derives the outer cleanup allowance from broker plus fallback scan budgets', () => {
    assert.equal(PROCESS_SCOPE_SCAN_TIMEOUT_MS, 2_000);
    assert.equal(PROCESS_SCOPE_SCAN_RETRIES, 2);
    assert.equal(PROCESS_SCOPE_POLL_MS, 250);
    assert.equal(PROCESS_SCOPE_SINGLE_SCAN_BUDGET_MS, 4_250);
    assert.equal(
      PROCESS_SCOPE_CLEANUP_ALLOWANCE_MS,
      PROCESS_SCOPE_SINGLE_SCAN_BUDGET_MS * (PROCESS_SCOPE_MAX_DRAIN_ATTEMPTS * 2 + 1) + 5_000,
    );
    assert.equal(PROCESS_SCOPE_CLEANUP_ALLOWANCE_MS, 111_250);
  });

  it('returns spawnSync-shaped success output and immutable invocation details', { skip: declaredSkip('macos-release-process-containment') }, () => {
    const args = ['-e', "process.stdout.write('hello'); process.stderr.write('warn')"];
    const result = runBoundedCommand(NODE, args, { ...BASE, label: 'greeting' });
    args[1] = 'mutated after invocation';
    assert.equal(result.ok, true);
    assert.equal(result.failureType, 'success');
    assert.equal(result.status, 0);
    assert.equal(result.stdout, 'hello');
    assert.equal(result.stderr, 'warn');
    assert.equal(result.label, 'greeting');
    assert.deepEqual(result.args, ['-e', "process.stdout.write('hello'); process.stderr.write('warn')"]);
    assert.ok(Object.isFrozen(result));
    assert.ok(Object.isFrozen(result.args));
  });

  it('reaps repeated broker-election candidates on macOS', { skip: declaredSkip('macos-lockf-broker') }, () => {
    const moduleUrl = new URL('./bounded-command.mjs', import.meta.url).href;
    const childSource = [
      `process.env.ASTRID_APP_BOUNDED_BROKER_SESSION = ${JSON.stringify('c'.repeat(32))};`,
      `const { runBoundedCommand } = await import(${JSON.stringify(moduleUrl)});`,
      'for (let index = 0; index < 12; index += 1) {',
      `  const result = runBoundedCommand(process.execPath, ['-e', \"process.stdout.write('reap-ok')\"], { timeoutMs: ${HANG_GUARD_MS}, maxBuffer: 64 * 1024, killSignal: 'SIGKILL' });`,
      "  if (result.failureType !== 'success' || result.stdout !== 'reap-ok') throw new Error(`bounded invocation ${index} failed: ${result.failureType}`);",
      '}',
      "await new Promise((resolvePromise) => setTimeout(resolvePromise, 100));",
      "const { execFileSync } = await import('node:child_process');",
      "const rows = execFileSync('/bin/ps', ['-axo', 'pid=,ppid=,stat=,command='], { encoding: 'utf8' }).split('\\n');",
      "const zombieCount = rows.filter((line) => { const match = line.match(/^\\s*(\\d+)\\s+(\\d+)\\s+(\\S+)\\s+(.*)$/); return match && Number(match[2]) === process.pid && match[3].includes('Z'); }).length;",
      'process.stdout.write(JSON.stringify({ zombieCount }));',
    ].join('\n');
    const output = execFileSync(NODE, ['--input-type=module', '-e', childSource], { encoding: 'utf8' });
    assert.deepEqual(JSON.parse(output), { zombieCount: 0 });
  });

  it('throws structured diagnostics for a nonzero exit', { skip: declaredSkip('macos-release-process-containment') }, () => {
    assert.throws(
      () => run("process.stdout.write('token=secret'); process.stderr.write('bad'); process.exit(7)", {
        label: 'nonzero-check',
        redact: ['secret'],
      }),
      (error) => {
        assert.ok(error instanceof BoundedCommandError);
        assert.equal(error.result.failureType, 'exit');
        assert.equal(error.result.status, 7);
        assert.match(error.result.stdout, /token=\[REDACTED\]/);
        assert.doesNotMatch(error.message, /secret/);
        return true;
      },
    );
  });

  it('redacts environment values by default', { skip: declaredSkip('macos-release-process-containment') }, () => {
    const secret = `bounded-output-secret-${process.pid}-${Date.now()}`;
    const result = run('process.stdout.write(process.env.BOUNDED_OUTPUT_SECRET)', {
      env: { PATH: process.env.PATH ?? '', BOUNDED_OUTPUT_SECRET: secret },
    });
    assert.equal(result.failureType, 'success');
    assert.equal(result.stdout, '[REDACTED]');
  });

  it('parses JSON before redaction, preserving CI booleans and freezing the payload', { skip: declaredSkip('macos-release-process-containment') }, () => {
    const runtimeRoot = `/var/folders/bounded-json-${process.pid}`;
    const result = run(
      'process.stdout.write(JSON.stringify({ ci: process.env.CI === "true", enabled: false, nested: { ok: true } }))',
      {
        env: { PATH: process.env.PATH ?? '', CI: 'true', TMPDIR: runtimeRoot },
        structuredOutput: 'json',
      },
    );
    assert.deepEqual(result.payload, { ci: true, enabled: false, nested: { ok: true } });
    assert.ok(Object.isFrozen(result.payload));
    assert.ok(Object.isFrozen(result.payload.nested));
    assert.match(result.stdout, /\[REDACTED\]/);
    assert.doesNotMatch(result.stdout, /bounded-json-/);
  });

  it('preserves absolute env-root paths and npm-like boolean/scrub shape in memory', { skip: declaredSkip('macos-release-process-containment') }, () => {
    const runtimeRoot = `/var/folders/npm-like-${process.pid}`;
    const result = run(
      'process.stdout.write(JSON.stringify({ name: "pkg", extraneous: false, resolved: `${process.env.TMPDIR}/node_modules/pkg`, dependencies: { dep: { dev: false } } }))',
      {
        env: { PATH: process.env.PATH ?? '', TMPDIR: runtimeRoot },
        structuredOutput: 'json',
      },
    );
    assert.equal(result.payload.resolved, `${runtimeRoot}/node_modules/pkg`);
    assert.equal(result.payload.extraneous, false);
    assert.equal(result.payload.dependencies.dep.dev, false);
    const scrubbed = JSON.parse(JSON.stringify(result.payload, (key, value) => (
      ['resolved', '_resolved', 'path', 'from'].includes(key) ? undefined : value
    )));
    assert.deepEqual(scrubbed, {
      name: 'pkg',
      extraneous: false,
      dependencies: { dep: { dev: false } },
    });
    assert.doesNotMatch(result.stdout, new RegExp(runtimeRoot.replaceAll('/', '\\/')));
  });

  it('fails closed on malformed structured JSON without leaking a secret', { skip: declaredSkip('macos-release-process-containment') }, () => {
    const secret = `malformed-structured-secret-${process.pid}`;
    const result = run(
      `process.stdout.write('not-json:${secret}'); process.stderr.write('stderr:${secret}')`,
      {
        env: { PATH: process.env.PATH ?? '', STRUCTURED_SECRET: secret },
        structuredOutput: 'json',
        allowFailure: true,
      },
    );
    assert.equal(result.ok, false);
    assert.equal(result.failureType, 'structured-output');
    assert.equal(result.payload, undefined);
    assert.equal(result.error?.code, 'EJSONPARSE');
    assert.doesNotMatch(result.stdout, new RegExp(secret));
    assert.doesNotMatch(result.stderr, new RegExp(secret));
    assert.doesNotMatch(result.error?.message ?? '', new RegExp(secret));
  });

  it('preserves boolean JSON when environment redaction is explicitly disabled', { skip: declaredSkip('macos-release-process-containment') }, () => {
    const secret = 'explicit-structured-secret';
    const result = run('process.stdout.write(JSON.stringify({overridden: false, enabled: true, secret: process.env.BOUNDED_JSON_SECRET}))', {
      env: {
        PATH: process.env.PATH ?? '',
        BOUNDED_JSON_CONTROL: 'false',
        BOUNDED_JSON_SECRET: secret,
      },
      redact: [secret],
      redactEnvValues: false,
    });
    assert.equal(result.failureType, 'success');
    assert.deepEqual(JSON.parse(result.stdout), { overridden: false, enabled: true, secret: '[REDACTED]' });
  });

  it('rejects a non-boolean environment-redaction policy', () => {
    assert.throws(
      () => run("process.stdout.write('unreachable')", { redactEnvValues: 'false' }),
      /redactEnvValues must be a boolean/,
    );
  });

  it('rejects structured output with binary mode', () => {
    assert.throws(
      () => run("process.stdout.write('x')", { encoding: null, structuredOutput: 'json' }),
      /structuredOutput cannot be used with binary output/,
    );
  });

  it('distinguishes a child signal from a timeout, including SIGTERM/SIGKILL-like signals', { skip: declaredSkip('macos-release-process-containment') }, () => {
    for (const signal of ['SIGTERM', 'SIGKILL']) {
      const result = run(`process.kill(process.pid, '${signal}')`, { allowFailure: true });
      assert.equal(result.ok, false);
      assert.equal(result.failureType, 'signal');
      assert.equal(result.signal, signal);
      assert.equal(result.error, null);
    }
  });

  it('reports spawn errors separately from child failures', { skip: declaredSkip('macos-release-process-containment') }, () => {
    const result = runBoundedCommand('/definitely/not/a/real/command', [], { ...BASE, allowFailure: true });
    assert.equal(result.ok, false);
    assert.equal(result.failureType, 'spawn-error');
    assert.equal(result.status, null);
    assert.match(result.error?.code ?? '', /ENOENT|EACCES/);
  });

  it('caps captured output and fails closed without retaining the full stream', { skip: declaredSkip('macos-release-process-containment') }, () => {
    const result = run("process.stdout.write('x'.repeat(100_000))", {
      maxBuffer: 256,
      structuredOutput: 'json',
      allowFailure: true,
    });
    assert.equal(result.failureType, 'output-cap');
    assert.equal(result.ok, false);
    assert.ok(Buffer.byteLength(result.stdout) <= 256);
    assert.equal(result.stdoutTruncated, true);
    assert.equal(result.payload, undefined);
  });

  it('times out and kills the child without leaving a marker behind', { skip: declaredSkip('macos-release-process-containment') }, () => {
    const root = mkdtempSync(resolve(tmpdir(), 'bounded-command-'));
    const marker = resolve(root, 'orphan-marker');
    try {
      const result = run(
        `setTimeout(() => require('node:fs').writeFileSync(${JSON.stringify(marker)}, 'orphan'), 1_000)`,
        { timeoutMs: 50, structuredOutput: 'json', allowFailure: true },
      );
      assert.equal(result.ok, false);
      assert.equal(result.failureType, 'timeout');
      assert.equal(result.status, null);
      assert.equal(result.signal, 'SIGKILL');
      assert.equal(result.error?.code, 'ETIMEDOUT');
      assert.equal(result.payload, undefined);
      assert.equal(existsSync(marker), false);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('forwards SIGTERM as the first timeout signal and reports SIGKILL only after escalation', { skip: declaredSkip('macos-release-process-containment') }, () => {
    const termResult = run(
      "process.on('SIGTERM', () => process.exit(0)); process.stdout.write('ready'); setInterval(() => {}, 1_000)",
      { timeoutMs: 50, killSignal: 'SIGTERM', allowFailure: true },
    );
    assert.equal(termResult.failureType, 'timeout');
    assert.equal(termResult.status, null);
    assert.equal(termResult.killSignal, 'SIGTERM');
    assert.equal(termResult.signal, 'SIGTERM');

    const killResult = run(
      "process.on('SIGTERM', () => {}); process.stdout.write('ready'); setInterval(() => {}, 1_000)",
      { timeoutMs: 50, killSignal: 'SIGTERM', allowFailure: true },
    );
    assert.equal(killResult.failureType, 'timeout');
    assert.equal(killResult.status, null);
    assert.equal(killResult.killSignal, 'SIGTERM');
    assert.equal(killResult.signal, 'SIGKILL');
  });

  it('cleans a detached unref descendant after the scoped leader exits first', { skip: declaredSkip('macos-release-process-containment') }, async () => {
    const root = mkdtempSync(resolve(tmpdir(), 'bounded-command-exited-leader-'));
    const marker = resolve(root, 'exited-leader-marker');
    try {
      const source = [
        "const { spawn } = require('node:child_process');",
        `const grandchild = spawn(process.execPath, ['-e', ${JSON.stringify(
          `setTimeout(() => require('node:fs').writeFileSync(${JSON.stringify(marker)}, 'orphan'), 700);`,
        )}], { detached: true, stdio: 'ignore' });`,
        'grandchild.unref();',
        'process.exit(0);',
      ].join('');
      const result = run(source, { timeoutMs: HANG_GUARD_MS, allowFailure: true });
      assert.equal(result.failureType, 'success');
      await new Promise((resolvePromise) => setTimeout(resolvePromise, 850));
      assert.equal(existsSync(marker), false);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('rescans the scope when a descendant spawns during TERM', { skip: declaredSkip('macos-release-process-containment') }, async () => {
    const root = mkdtempSync(resolve(tmpdir(), 'bounded-command-term-spawn-'));
    const marker = resolve(root, 'term-spawn-marker');
    try {
      const source = [
        "const { spawn } = require('node:child_process');",
        `process.on('SIGTERM', () => { const child = spawn(process.execPath, ['-e', ${JSON.stringify(
          `setTimeout(() => require('node:fs').writeFileSync(${JSON.stringify(marker)}, 'orphan'), 700);`,
        )}], { detached: true, stdio: 'ignore' }); child.unref(); process.exit(0); });`,
        "process.stdout.write('ready'); setInterval(() => {}, 1_000);",
      ].join('');
      const result = run(source, { timeoutMs: 80, killSignal: 'SIGTERM', allowFailure: true });
      assert.equal(result.failureType, 'timeout');
      await new Promise((resolvePromise) => setTimeout(resolvePromise, 850));
      assert.equal(existsSync(marker), false);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('keeps twenty concurrent scoped cleanups isolated from an unrelated process', { skip: declaredSkip('macos-release-process-containment') }, async () => {
    const root = mkdtempSync(resolve(tmpdir(), 'bounded-command-parallel-scope-'));
    const released = resolve(root, 'cleanup-returned');
    const unrelated = spawn(NODE, ['-e', 'setInterval(() => {}, 1_000)'], { detached: true, stdio: 'ignore' });
    unrelated.unref();
    const moduleUrl = new URL('./bounded-command.mjs', import.meta.url).href;
    const workerSource = `
      const { parentPort, workerData } = require('node:worker_threads');
      import(workerData.moduleUrl).then(({ runBoundedCommand }) => {
        const result = runBoundedCommand(process.execPath, ['-e', workerData.source], workerData.options);
        parentPort.postMessage(result.failureType);
      }).catch((error) => parentPort.postMessage({ error: error.message }));
    `;
    try {
      const workers = Array.from({ length: 20 }, (_, index) => {
        const marker = resolve(root, `parallel-${index}.marker`);
        const source = [
          "const { spawn } = require('node:child_process');",
          `const child = spawn(process.execPath, ['-e', ${JSON.stringify(
            `const fs = require('node:fs'); const timer = setInterval(() => { if (!fs.existsSync(${JSON.stringify(root)})) { clearInterval(timer); return; } if (fs.existsSync(${JSON.stringify(released)})) { fs.writeFileSync(${JSON.stringify(marker)}, 'orphan'); clearInterval(timer); } }, 10);`,
          )}], { detached: true, stdio: 'ignore' });`,
          'child.unref(); process.exit(0);',
        ].join('');
        return new Promise((resolvePromise, reject) => {
          const worker = new Worker(workerSource, {
            eval: true,
            // The command exits at once; the bound is only a hang guard, so a slow runner starting twenty at a time cannot make it a timeout.
            workerData: { moduleUrl, source, options: { ...BASE, allowFailure: true } },
          });
          worker.once('message', (message) => { worker.terminate(); resolvePromise(message); });
          worker.once('error', reject);
        });
      });
      const results = await Promise.all(workers);
      assert.deepEqual(results, Array(20).fill('success'));
      // A descendant running during cleanup is allowed. Only a process that
      // survives the completed cleanup can observe this release and write.
      writeFileSync(released, 'cleanup returned');
      await new Promise((resolvePromise) => setTimeout(resolvePromise, 750));
      for (let index = 0; index < 20; index += 1) assert.equal(existsSync(resolve(root, `parallel-${index}.marker`)), false);
      assert.doesNotThrow(() => process.kill(unrelated.pid, 0));
    } finally {
      try { process.kill(unrelated.pid, 'SIGKILL'); } catch { /* already exited */ }
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('preserves outer scope ownership across a nested bounded command', { skip: declaredSkip('macos-release-process-containment') }, async () => {
    const root = mkdtempSync(resolve(tmpdir(), 'bounded-command-nested-scope-'));
    const ready = resolve(root, 'inner-ready');
    const marker = resolve(root, 'nested-orphan-marker');
    const moduleUrl = new URL('./bounded-command.mjs', import.meta.url).href;
    try {
      const innerSource = [
        "const { spawn } = require('node:child_process');",
        "const { writeFileSync } = require('node:fs');",
        `writeFileSync(${JSON.stringify(ready)}, 'ready');`,
        `const child = spawn(process.execPath, ['-e', ${JSON.stringify(
          `setTimeout(() => require('node:fs').writeFileSync(${JSON.stringify(marker)}, 'orphan'), 2_500);`,
        )}], { detached: true, stdio: 'ignore' });`,
        'child.unref(); setInterval(() => {}, 1_000);',
      ].join('');
      const outerSource = [
        `import(${JSON.stringify(moduleUrl)}).then(({ runBoundedCommand }) => {`,
        `runBoundedCommand(process.execPath, ['-e', ${JSON.stringify(innerSource)}], {`,
        'timeoutMs: 10_000, maxBuffer: 64 * 1024, killSignal: "SIGTERM", allowFailure: true,',
        '}); });',
      ].join('');
      const result = run(outerSource, { timeoutMs: 1_500, killSignal: 'SIGTERM', allowFailure: true });
      assert.equal(result.failureType, 'timeout');
      assert.equal(existsSync(ready), true, 'nested target never launched, so cleanup was not exercised');
      await new Promise((resolvePromise) => setTimeout(resolvePromise, 2_800));
      assert.equal(existsSync(marker), false);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('keeps invocation and environment secrets out of helper process listings', { skip: declaredSkip('macos-release-process-containment') }, () => {
    const secret = `bounded-secret-${process.pid}-${Date.now()}`;
    const source = [
      "const { execFileSync } = require('node:child_process');",
      "let listing; try { listing = execFileSync('/bin/ps', ['eww', '-axo', 'pid=,ppid=,command='], { encoding: 'utf8', maxBuffer: 8 * 1024 * 1024 }); } catch (error) { throw new Error('Process listing failed: ' + (error.code || error.status)); }",
      "const rows = listing.split('\\n');",
      'const parent = process.ppid;',
      "const parentRow = rows.find((row) => Number(row.trim().split(/\\s+/, 1)[0]) === parent) || '';",
      "const parentParts = parentRow.trim().split(/\\s+/);",
      'const wrapper = Number(parentParts[1]);',
      "const relevant = rows.filter((row) => Number(row.trim().split(/\\s+/, 1)[0]) !== process.pid && (row.includes('bounded-command-wrapper.mjs') || row.includes('bounded-command-target-gate.mjs')));",
      "const leaked = relevant.some((row) => row.includes(process.env.BOUNDED_PARENT_SECRET)) || Boolean(process.env.ASTRID_APP_BOUNDED_BROKER_SESSION);",
      "process.stdout.write(leaked ? 'leaked' : 'safe');",
    ].join('');
    const previous = process.env.BOUNDED_PARENT_SECRET;
    process.env.BOUNDED_PARENT_SECRET = secret;
    try {
      const result = run(source, { timeoutMs: HANG_GUARD_MS });
      assert.equal(result.failureType, 'success');
      assert.equal(result.stdout, 'safe');
      assert.equal(result.args.some((arg) => arg.includes(secret)), false);
      assert.equal(result.error?.message?.includes(secret) ?? false, false);
    } finally {
      if (previous === undefined) delete process.env.BOUNDED_PARENT_SECRET;
      else process.env.BOUNDED_PARENT_SECRET = previous;
    }
  });

  it('fails closed and locally drains the scope when the shared broker is killed', { skip: declaredSkip('macos-release-process-containment') }, async () => {
    const root = mkdtempSync(resolve(tmpdir(), 'bounded-command-broker-death-'));
    const ready = resolve(root, 'target-ready');
    const childReady = resolve(root, 'orphan-child-ready');
    const marker = resolve(root, 'broker-death-orphan');
    const moduleUrl = new URL('./bounded-command.mjs', import.meta.url).href;
    let orphanChildPid = null;
    const workerSource = `
      const { parentPort, workerData } = require('node:worker_threads');
      import(workerData.moduleUrl).then(({ runBoundedCommand }) => {
        parentPort.postMessage(runBoundedCommand(process.execPath, ['-e', workerData.source], workerData.options));
      }).catch((error) => parentPort.postMessage({ workerError: error.stack || error.message }));
    `;
    try {
      const initial = run("process.stdout.write('broker-ready')", { allowFailure: true });
      assert.equal(initial.failureType, 'success');
      const ownedBrokerPattern = new RegExp(
        `bounded-command-wrapper\\.mjs --broker\\s+\\S+\\s+\\S+\\s+${process.pid}\\s+`,
      );
      const ownedBrokers = execFileSync('/bin/ps', ['-axo', 'pid=,ppid=,command='], { encoding: 'utf8' })
        .split('\n')
        .map((line) => line.match(/^\s*(\d+)\s+(\d+)\s+(.*)$/))
        .filter((match) => match
          && ownedBrokerPattern.test(match[3])
          && !match[3].startsWith('/usr/bin/lockf '));
      assert.equal(ownedBrokers.length, 1, 'expected exactly one broker owned by this test process');
      const brokerPid = Number(ownedBrokers[0][1]);

      const targetSource = [
        "const { spawn } = require('node:child_process');",
        "const { existsSync, writeFileSync } = require('node:fs');",
        `const child = spawn(process.execPath, ['-e', ${JSON.stringify(
          `require('node:fs').writeFileSync(${JSON.stringify(childReady)}, String(process.pid)); setTimeout(() => require('node:fs').writeFileSync(${JSON.stringify(marker)}, 'orphan'), 60_000);`,
        )}], { detached: true, stdio: 'ignore' });`,
        'child.unref();',
        `const readyTimer = setInterval(() => { if (existsSync(${JSON.stringify(childReady)})) { clearInterval(readyTimer); writeFileSync(${JSON.stringify(ready)}, 'ready'); } }, 20);`,
        'setInterval(() => {}, 1_000);',
      ].join('');
      const resultPromise = new Promise((resolvePromise, reject) => {
        const worker = new Worker(workerSource, {
          eval: true,
          workerData: {
            moduleUrl,
            source: targetSource,
            options: { ...BASE, timeoutMs: 1_200, killSignal: 'SIGTERM', allowFailure: true },
          },
        });
        worker.once('message', (message) => { worker.terminate(); resolvePromise(message); });
        worker.once('error', reject);
      });
      const deadline = Date.now() + 4_000;
      while (!existsSync(ready) && Date.now() < deadline) {
        await new Promise((resolvePromise) => setTimeout(resolvePromise, 25));
      }
      assert.equal(existsSync(ready), true, 'target and detached child did not become ready before broker kill');
      orphanChildPid = Number(readFileSync(childReady, 'utf8'));
      assert.ok(Number.isSafeInteger(orphanChildPid) && orphanChildPid > 0, 'detached child did not report its PID');
      process.kill(brokerPid, 'SIGKILL');
      const result = await resultPromise;
      assert.equal(result.failureType, 'cleanup-error');
      assert.match(result.cleanupError?.message ?? '', /broker failed; local fallback cleanup completed/);
      const recovered = run("process.stdout.write('recovered')", { timeoutMs: HANG_GUARD_MS, allowFailure: true });
      assert.equal(recovered.failureType, 'success');
      assert.equal(recovered.stdout, 'recovered');
      const childState = processState(orphanChildPid);
      assert.equal(childState === '' || childState.startsWith('Z'), true, 'detached descendant remained live after local fallback');
      assert.equal(existsSync(marker), false);
    } finally {
      if (orphanChildPid) {
        const childState = processState(orphanChildPid);
        if (childState && !childState.startsWith('Z')) {
          try { process.kill(orphanChildPid, 'SIGKILL'); } catch { /* already exited */ }
        }
      }
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('recovers corrupt stale broker lock, readiness, and socket artifacts', { skip: declaredSkip('macos-release-process-containment') }, () => {
    const moduleUrl = new URL('./bounded-command.mjs', import.meta.url).href;
    const session = 'a'.repeat(32);
    const childSource = [
      "import { mkdirSync, rmSync, writeFileSync } from 'node:fs';",
      "import { join } from 'node:path';",
      `process.env.ASTRID_APP_BOUNDED_BROKER_SESSION = ${JSON.stringify(session)};`,
      `const root = join(${JSON.stringify('/tmp')}, \`rb-\${process.pid}-${session.slice(0, 12)}\`);`,
      "mkdirSync(root, { mode: 0o700 });",
      "const socket = join(root, 'broker.sock');",
      "writeFileSync(`${socket}.lock`, 'corrupt-lock');",
      "writeFileSync(`${socket}.lock.takeover`, 'stale-takeover-mutex');",
      "writeFileSync(`${socket}.ready`, 'corrupt-ready');",
      "writeFileSync(socket, 'not-a-socket');",
      'try {',
      `  const { runBoundedCommand } = await import(${JSON.stringify(moduleUrl)});`,
      "  const result = runBoundedCommand(process.execPath, ['-e', \"process.stdout.write('recovered')\"], {",
      `    timeoutMs: ${HANG_GUARD_MS}, maxBuffer: 64 * 1024, killSignal: 'SIGKILL', allowFailure: true,`,
      '  });',
      "  process.stdout.write(JSON.stringify({ failureType: result.failureType, stdout: result.stdout }));",
      '} finally {',
      '  rmSync(root, { recursive: true, force: true });',
      '}',
    ].join('\n');
    const output = execFileSync(NODE, ['--input-type=module', '-e', childSource], { encoding: 'utf8' });
    assert.deepEqual(JSON.parse(output), { failureType: 'success', stdout: 'recovered' });
  });

  it('survives lock-guardian death and restarts after broker death', { skip: declaredSkip('macos-release-process-containment') }, async () => {
    const initial = run("process.stdout.write('initial')", { allowFailure: true });
    assert.equal(initial.failureType, 'success');
    const ownedBrokerPattern = new RegExp(
      `bounded-command-wrapper\\.mjs --broker\\s+\\S+\\s+\\S+\\s+${process.pid}\\s+`,
    );
    const brokerRow = () => execFileSync('/bin/ps', ['-axo', 'pid=,ppid=,command='], { encoding: 'utf8' })
      .split('\n')
      .map((line) => line.match(/^\s*(\d+)\s+(\d+)\s+(.*)$/))
      .find((match) => match
        && ownedBrokerPattern.test(match[3])
        && !match[3].startsWith('/usr/bin/lockf '));
    const before = brokerRow();
    assert.ok(before, 'kernel-elected broker was not found');
    const brokerPid = Number(before[1]);
    const guardianPid = Number(before[2]);
    const guardian = execFileSync('/bin/ps', ['-p', String(guardianPid), '-o', 'command='], { encoding: 'utf8' });
    assert.match(guardian, /\/usr\/bin\/lockf/);

    process.kill(guardianPid, 'SIGKILL');
    const guardianDeadline = Date.now() + 1_000;
    while (Date.now() < guardianDeadline) {
      try { process.kill(guardianPid, 0); } catch { break; }
      await new Promise((resolvePromise) => setTimeout(resolvePromise, 20));
    }
    assert.throws(() => process.kill(guardianPid, 0), /ESRCH/);

    const afterGuardian = run("process.stdout.write('still-owned')", { allowFailure: true });
    assert.equal(afterGuardian.failureType, 'success');
    assert.equal(afterGuardian.stdout, 'still-owned');
    assert.equal(Number(brokerRow()?.[1]), brokerPid, 'guardian loss started a duplicate broker');

    process.kill(brokerPid, 'SIGKILL');
    const recovered = run("process.stdout.write('re-elected')", { allowFailure: true });
    assert.equal(recovered.failureType, 'success');
    assert.equal(recovered.stdout, 're-elected');
    assert.notEqual(Number(brokerRow()?.[1]), brokerPid, 'broker death did not elect a replacement');
  });

  it('serializes concurrent recovery of a corrupt/dead broker lock', { skip: declaredSkip('macos-release-process-containment') }, () => {
    const moduleUrl = new URL('./bounded-command.mjs', import.meta.url).href;
    const session = 'b'.repeat(32);
    const childSource = [
      "import { mkdirSync, rmSync, writeFileSync } from 'node:fs';",
      "import { join } from 'node:path';",
      "import { Worker } from 'node:worker_threads';",
      `process.env.ASTRID_APP_BOUNDED_BROKER_SESSION = ${JSON.stringify(session)};`,
      `const root = join(${JSON.stringify('/tmp')}, \`rb-\${process.pid}-${session.slice(0, 12)}\`);`,
      "mkdirSync(root, { mode: 0o700 });",
      "const socket = join(root, 'broker.sock');",
      "writeFileSync(`${socket}.lock`, JSON.stringify({ pid: 999999, nonce: 'cccccccccccccccccccccccccccccccc' }));",
      "writeFileSync(`${socket}.ready`, 'stale-ready');",
      "writeFileSync(socket, 'stale-socket');",
      `const workerSource = ${JSON.stringify(`
        const { parentPort, workerData } = require('node:worker_threads');
        import(workerData.moduleUrl).then(({ runBoundedCommand }) => {
          const result = runBoundedCommand(process.execPath, ['-e', "process.stdout.write('stress-ok')"], {
            timeoutMs: ${HANG_GUARD_MS}, maxBuffer: 64 * 1024, killSignal: 'SIGKILL', allowFailure: true,
          });
          parentPort.postMessage({ failureType: result.failureType, stdout: result.stdout });
        }).catch((error) => parentPort.postMessage({ error: error.stack || error.message }));
      `)};`,
      `const moduleUrl = ${JSON.stringify(moduleUrl)};`,
      'const workers = Array.from({ length: 12 }, () => new Promise((resolvePromise, reject) => {',
      '  const worker = new Worker(workerSource, { eval: true, execArgv: [], workerData: { moduleUrl } });',
      '  worker.once(\'message\', resolvePromise); worker.once(\'error\', reject);',
      '}));',
      'const results = await Promise.all(workers);',
      'process.stdout.write(JSON.stringify(results));',
      'rmSync(root, { recursive: true, force: true });',
    ].join('\n');
    const output = execFileSync(NODE, ['--input-type=module', '-e', childSource], { encoding: 'utf8' });
    const results = JSON.parse(output);
    assert.equal(results.length, 12);
    assert.deepEqual(results, Array.from({ length: 12 }, () => ({ failureType: 'success', stdout: 'stress-ok' })));
  });

  it('aborts a wrapper that loses its parent before target startup', async () => {
    const root = mkdtempSync(resolve(tmpdir(), 'bounded-command-pre-target-parent-death-'));
    const wrapperPidFile = resolve(root, 'wrapper-pid');
    const targetStarted = resolve(root, 'target-started');
    const deadSocket = resolve(root, 'not-started.sock');
    const wrapperPath = resolve(new URL('./bounded-command-wrapper.mjs', import.meta.url).pathname);
    const callerSource = [
      "const { spawn } = require('node:child_process');",
      "const { writeFileSync } = require('node:fs');",
      `const wrapper = spawn(process.execPath, [${JSON.stringify(wrapperPath)}], { stdio: ['pipe', 'ignore', 'ignore'] });`,
      `writeFileSync(${JSON.stringify(wrapperPidFile)}, String(wrapper.pid));`,
      `wrapper.stdin.end(JSON.stringify({ command: process.execPath, args: ['-e', ${JSON.stringify(`require('node:fs').writeFileSync(${JSON.stringify(targetStarted)}, 'started'); setTimeout(() => {}, 30000)`)}], timeoutMs: 30000, maxBuffer: 65536, killSignal: 'SIGKILL', scopeKey: 'ASTRID_APP_BOUNDED_PROCESS_SCOPE_pre_target', scopeToken: 'dddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddd', parentPid: process.pid, brokerSocket: ${JSON.stringify(deadSocket)} }));`,
      'setInterval(() => {}, 1000);',
    ].join('');
    const caller = spawn(NODE, ['-e', callerSource], { stdio: 'ignore' });
    try {
      const deadline = Date.now() + 2_000;
      while (!existsSync(wrapperPidFile) && Date.now() < deadline) {
        await new Promise((resolvePromise) => setTimeout(resolvePromise, 10));
      }
      assert.equal(existsSync(wrapperPidFile), true, 'wrapper did not start');
      const wrapperPid = Number(readFileSync(wrapperPidFile, 'utf8'));
      process.kill(caller.pid, 'SIGKILL');
      await new Promise((resolvePromise) => caller.once('close', resolvePromise));
      const exitDeadline = Date.now() + 700;
      while (Date.now() < exitDeadline) {
        try { process.kill(wrapperPid, 0); } catch { break; }
        await new Promise((resolvePromise) => setTimeout(resolvePromise, 25));
      }
      assert.throws(() => process.kill(wrapperPid, 0), /ESRCH/);
      assert.equal(existsSync(targetStarted), false, 'target launched after parent death');
    } finally {
      try { process.kill(caller.pid, 'SIGKILL'); } catch { /* already exited */ }
      try { rmSync(root, { recursive: true, force: true }); } catch { /* already removed */ }
    }
  });

  it('drains the owned scope when the direct wrapper is killed', { skip: declaredSkip('macos-release-process-containment') }, async () => {
    const root = mkdtempSync(resolve(tmpdir(), 'bounded-command-wrapper-death-'));
    const ready = resolve(root, 'target-ready');
    const marker = resolve(root, 'wrapper-death-orphan');
    const moduleUrl = new URL('./bounded-command.mjs', import.meta.url).href;
    const callerSource = [
      `import(${JSON.stringify(moduleUrl)}).then(({ runBoundedCommand }) => {`,
      `const result = runBoundedCommand(process.execPath, ['-e', ${JSON.stringify([
        "const { spawn } = require('node:child_process');",
        "const { writeFileSync } = require('node:fs');",
        `writeFileSync(${JSON.stringify(ready)}, 'ready');`,
        `const child = spawn(process.execPath, ['-e', ${JSON.stringify(
          `setTimeout(() => require('node:fs').writeFileSync(${JSON.stringify(marker)}, 'orphan'), 2_500);`,
        )}], { detached: true, stdio: 'ignore' });`,
        'child.unref(); setInterval(() => {}, 1_000);',
      ].join(''))}], { timeoutMs: 30_000, maxBuffer: 65536, killSignal: 'SIGTERM', allowFailure: true });`,
      'process.stdout.write(JSON.stringify({ failureType: result.failureType, signal: result.signal })); });',
    ].join('');
    const caller = spawn(NODE, ['--input-type=module', '-e', callerSource], { stdio: ['ignore', 'pipe', 'ignore'] });
    try {
      const readyDeadline = Date.now() + 4_000;
      while (!existsSync(ready) && Date.now() < readyDeadline) {
        await new Promise((resolvePromise) => setTimeout(resolvePromise, 25));
      }
      assert.equal(existsSync(ready), true, 'target did not become ready');
      const wrapperRow = execFileSync('/bin/ps', ['-axo', 'pid=,ppid=,command='], { encoding: 'utf8' })
        .split('\n')
        .map((line) => ({ line, match: line.match(/^\s*(\d+)\s+(\d+)\s+(.*)$/) }))
        .find(({ match }) => match && Number(match[2]) === caller.pid
          && match[3].includes('bounded-command-wrapper.mjs')
          && !match[3].includes(' --broker '));
      assert.ok(wrapperRow?.match, 'direct wrapper process was not found');
      process.kill(Number(wrapperRow.match[1]), 'SIGKILL');
      await new Promise((resolvePromise) => caller.once('close', resolvePromise));
      await new Promise((resolvePromise) => setTimeout(resolvePromise, 2_800));
      assert.equal(existsSync(marker), false);
      const leaked = execFileSync('/bin/ps', ['-axo', 'command='], { encoding: 'utf8' })
        .split('\n').some((line) => line.includes(marker));
      assert.equal(leaked, false);
    } finally {
      try { process.kill(caller.pid, 'SIGKILL'); } catch { /* already exited */ }
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('kills the complete owned scope when the synchronous parent is SIGKILLed', { skip: declaredSkip('macos-release-process-containment') }, async () => {
    const root = mkdtempSync(resolve(tmpdir(), 'bounded-command-parent-death-'));
    const ready = resolve(root, 'target-ready');
    const marker = resolve(root, 'parent-death-orphan');
    const moduleUrl = new URL('./bounded-command.mjs', import.meta.url).href;
    try {
      const targetSource = [
        "const { spawn } = require('node:child_process');",
        "const { writeFileSync } = require('node:fs');",
        `writeFileSync(${JSON.stringify(ready)}, 'ready');`,
        `const child = spawn(process.execPath, ['-e', ${JSON.stringify(
          `setTimeout(() => require('node:fs').writeFileSync(${JSON.stringify(marker)}, 'orphan'), 2_500);`,
        )}], { detached: true, stdio: 'ignore' });`,
        'child.unref(); setInterval(() => {}, 1_000);',
      ].join('');
      const callerSource = [
        `import(${JSON.stringify(moduleUrl)}).then(({ runBoundedCommand }) => {`,
        `runBoundedCommand(process.execPath, ['-e', ${JSON.stringify(targetSource)}], {`,
        'timeoutMs: 30_000, maxBuffer: 64 * 1024, killSignal: "SIGTERM", allowFailure: true,',
        '}); });',
      ].join('');
      const caller = spawn(NODE, ['--input-type=module', '-e', callerSource], {
        stdio: 'ignore',
      });
      const deadline = Date.now() + 4_000;
      while (!existsSync(ready) && Date.now() < deadline) {
        await new Promise((resolvePromise) => setTimeout(resolvePromise, 25));
      }
      assert.equal(existsSync(ready), true, 'target did not launch before parent death');
      process.kill(caller.pid, 'SIGKILL');
      await new Promise((resolvePromise) => caller.once('close', resolvePromise));
      await new Promise((resolvePromise) => setTimeout(resolvePromise, 2_800));
      assert.equal(existsSync(marker), false);
      const leaked = execFileSync('/bin/ps', ['-axo', 'command='], { encoding: 'utf8' })
        .split('\n')
        .some((line) => line.includes(marker));
      assert.equal(leaked, false, 'a target or detached descendant survived its parent');
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('kills a detached and unref grandchild before it can leave an orphan marker', { skip: declaredSkip('macos-release-process-containment') }, async () => {
    const root = mkdtempSync(resolve(tmpdir(), 'bounded-command-grandchild-'));
    const marker = resolve(root, 'detached-grandchild-marker');
    try {
      const source = [
        "const { spawn } = require('node:child_process');",
        "const fs = require('node:fs');",
        `const grandchild = spawn(process.execPath, ['-e', ${JSON.stringify(
          `setTimeout(() => require('node:fs').writeFileSync(${JSON.stringify(marker)}, 'orphan'), 900);`,
        )}], { detached: true, stdio: 'ignore' });`,
        'grandchild.unref();',
        'setInterval(() => {}, 1_000);',
      ].join('');
      const result = run(source, { timeoutMs: 75, allowFailure: true });
      assert.equal(result.failureType, 'timeout');
      await new Promise((resolve) => setTimeout(resolve, 1_050));
      assert.equal(existsSync(marker), false);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('refuses clearly off macOS, after validating its arguments', () => {
    const real = Object.getOwnPropertyDescriptor(process, 'platform');
    Object.defineProperty(process, 'platform', { ...real, value: 'linux' });
    try {
      assert.throws(() => run('process.exit(0)'), /macOS-only by design.*linux is unsupported/);
      assert.throws(() => run('process.exit(0)', { timeoutMs: 0 }), /positive/);
    } finally {
      Object.defineProperty(process, 'platform', real);
    }
  });

  it('requires positive bounds and never permits a shell', () => {
    for (const [key, value] of [['timeoutMs', 0], ['maxBuffer', 0]]) {
      assert.throws(() => run('process.exit(0)', { [key]: value }), /positive/);
    }
    assert.throws(() => run('process.exit(0)', { shell: true }), /shell is forbidden/);
    assert.throws(() => run('process.exit(0)', { killSignal: '' }), /killSignal/);
    assert.throws(() => run('process.exit(0)', { killSignal: 'SIG_NOT_REAL' }), /supported by this platform/);
    assert.throws(() => run('process.exit(0)', { killSignal: 999_999 }), /supported by this platform/);
  });
});
