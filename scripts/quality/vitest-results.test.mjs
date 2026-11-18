import { it } from 'node:test';
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = fileURLToPath(new URL('../..', import.meta.url));

it('retains completed test evidence after the real Vitest process group is killed', { timeout: 30_000 }, async () => {
  const root = mkdtempSync(path.join(os.tmpdir(), 'p39-vitest-killed-'));
  const stream = path.join(root, 'killed.xml.jsonl');
  const config = path.join(root, 'vitest.config.mts');
  symlinkSync(path.join(ROOT, 'node_modules'), path.join(root, 'node_modules'), 'junction');
  writeFileSync(config, `import SkipGuardReporter from ${JSON.stringify(path.join(ROOT, 'config/testing/skipGuardReporter.ts'))};
    export default { root: ${JSON.stringify(root)}, test: { include: ['*.fixture.ts'], includeTaskLocation: true,
      reporters: [new SkipGuardReporter({ resultsFile: ${JSON.stringify(stream)} })] } };`);
  writeFileSync(path.join(root, 'kill.fixture.ts'), `import { it } from 'vitest';
    it('finished before termination', () => {});
    it('still running at termination', async () => { await new Promise(() => {}); }, 120000);`);
  const child = spawn(process.execPath, [path.join(ROOT, 'node_modules/vitest/vitest.mjs'), 'run', '--config', config], {
    cwd: root, detached: true, env: { ...process.env, CI: '' }, stdio: ['ignore', 'pipe', 'pipe'],
  });
  let output = '';
  child.stdout.on('data', (chunk) => { output += chunk; });
  child.stderr.on('data', (chunk) => { output += chunk; });
  const closed = new Promise((resolve) => child.on('close', (code, signal) => resolve({ code, signal })));
  const kill = () => {
    if (child.exitCode !== null || child.signalCode !== null) return;
    if (process.platform === 'win32') spawnSync('taskkill', ['/pid', String(child.pid), '/T', '/F']);
    else process.kill(-child.pid, 'SIGKILL');
  };
  try {
    const deadline = Date.now() + 20_000;
    while (!existsSync(stream) || !readFileSync(stream, 'utf8').includes('"event":"result"')) {
      assert.equal(child.exitCode, null, output);
      assert.equal(child.signalCode, null, output);
      assert.ok(Date.now() < deadline, `no finished-test record before deadline: ${output}`);
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    kill();
    const stopped = await closed;
    assert.notEqual(stopped.code, 0);
    const records = readFileSync(stream, 'utf8').trim().split('\n').map((line) => JSON.parse(line));
    assert.deepEqual(records.filter((record) => record.event === 'result').map((record) => [record.name, record.state]), [['finished before termination', 'passed']]);
    assert.equal(records.some((record) => record.event === 'end'), false);
    assert.equal(records.find((record) => record.event === 'collected').tests.length, 2);
    const check = spawnSync('python3', [path.join(ROOT, 'scripts/quality/check-vitest-results.py'), root, '--expected', 'killed.xml'], { encoding: 'utf8' });
    assert.equal(check.status, 1, check.stdout + check.stderr);
    assert.match(check.stdout, /1 finished result\(s\) retained, no final end record/);
  } finally {
    kill();
    await closed;
    rmSync(root, { recursive: true, force: true });
  }
});

it('checks a real failed run and its declared skip against XML, summary and streamed IDs', () => {
  const root = mkdtempSync(path.join(os.tmpdir(), 'p39-vitest-complete-'));
  const xml = path.join(root, 'probe.xml');
  const config = path.join(root, 'vitest.config.mts');
  try {
    symlinkSync(path.join(ROOT, 'node_modules'), path.join(root, 'node_modules'), 'junction');
    writeFileSync(config, `import SkipGuardReporter from ${JSON.stringify(path.join(ROOT, 'config/testing/skipGuardReporter.ts'))};
      export default { root: ${JSON.stringify(root)}, test: { include: ['*.fixture.ts'], includeTaskLocation: true,
        reporters: ['default', new SkipGuardReporter({ resultsFile: ${JSON.stringify(xml + '.jsonl')} }), ['junit', { outputFile: ${JSON.stringify(xml)} }]] } };`);
    writeFileSync(path.join(root, 'complete.fixture.ts'), `import { expect, it } from 'vitest';
      import { skipWhen } from ${JSON.stringify(path.join(ROOT, 'src/test/declaredSkip.ts'))};
      it('ordinary pass', () => {});
      it('intentional failing evidence probe', () => { expect(1).toBe(2); });
      it('declared condition', (ctx) => { skipWhen('direct-journey-harness', ctx); });`);
    const result = spawnSync(process.execPath, [path.join(ROOT, 'node_modules/vitest/vitest.mjs'), 'run', '--config', config], {
      cwd: root, env: { ...process.env, CI: '', ASTRID_RUNTIME_CHECKOUT: path.join(root, 'no-runtime') }, encoding: 'utf8',
    });
    assert.equal(result.status, 1, result.stdout + result.stderr);
    assert.match(result.stdout + result.stderr, /declared skips \(1\)/);
    writeFileSync(path.join(root, 'probe.log'), result.stdout + result.stderr);
    const check = spawnSync('python3', [path.join(ROOT, 'scripts/quality/check-vitest-results.py'), root, '--expected', 'probe.xml'], { encoding: 'utf8' });
    assert.equal(check.status, 0, check.stdout + check.stderr);
    assert.match(check.stdout, /actual tests=3 finished=3 failures=1 skipped=1/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

it('reconciles actual JUnit control-character encoding while retaining raw streamed names', () => {
  const root = mkdtempSync(path.join(os.tmpdir(), 'p39-vitest-xml-names-'));
  const xml = path.join(root, 'names.xml');
  const config = path.join(root, 'vitest.config.mts');
  const names = ['tab\tpath', 'line\nbreak', 'cr\rpath', 'crlf\r\npath', 'nul\0path', 'del\x7fpath', 'literal & < > "', 'nel\u0085path', 'astral\u{1f600}'];
  try {
    symlinkSync(path.join(ROOT, 'node_modules'), path.join(root, 'node_modules'), 'junction');
    writeFileSync(config, `import SkipGuardReporter from ${JSON.stringify(path.join(ROOT, 'config/testing/skipGuardReporter.ts'))};
      export default { root: ${JSON.stringify(root)}, test: { include: ['*.fixture.ts'], includeTaskLocation: true,
        reporters: ['default', new SkipGuardReporter({ resultsFile: ${JSON.stringify(xml + '.jsonl')} }), ['junit', { outputFile: ${JSON.stringify(xml)} }]] } };`);
    writeFileSync(path.join(root, 'names.fixture.ts'), `import { it } from 'vitest';
      for (const name of ${JSON.stringify(names)}) it(name, () => {});`);
    const result = spawnSync(process.execPath, [path.join(ROOT, 'node_modules/vitest/vitest.mjs'), 'run', '--config', config], {
      cwd: root, env: { ...process.env, CI: '' }, encoding: 'utf8',
    });
    assert.equal(result.status, 0, result.stdout + result.stderr);
    writeFileSync(path.join(root, 'names.log'), result.stdout + result.stderr);
    const finished = readFileSync(xml + '.jsonl', 'utf8').trim().split('\n').map(JSON.parse).filter((record) => record.event === 'result');
    assert.deepEqual(finished.map((record) => record.name), names);
    const check = spawnSync('python3', [path.join(ROOT, 'scripts/quality/check-vitest-results.py'), root, '--expected', 'names.xml'], { encoding: 'utf8' });
    assert.equal(check.status, 0, check.stdout + check.stderr);
    assert.match(check.stdout, /actual tests=9 finished=9 failures=0 skipped=0/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
