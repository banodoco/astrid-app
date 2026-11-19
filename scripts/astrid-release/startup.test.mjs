// Exercise the actual release-shell startup loop; only process launch/readiness are doubled.
// Run on hosted macOS. No live installation, network, or external process is touched.
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, rmSync, existsSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { test } from 'node:test';

const tool = process.env.RELEASE_TOOL_UNDER_TEST || new URL('./astrid-release', import.meta.url).pathname;
const known = 'accepted commit inputs changed during verification';
const quote = (text) => `'${String(text).replaceAll("'", "'\\''")}'`;

function startup(t, { failures, runtimeHistory = '', successAt = 99 }) {
  const root = mkdtempSync(path.join(tmpdir(), 'p61-startup-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  for (const name of ['logs', 'state', 'data/runtime', 'home/Library/Logs/Astrid Runtime', 'bootstrap']) {
    mkdirSync(path.join(root, name), { recursive: true });
  }
  writeFileSync(path.join(root, 'home/Library/Logs/Astrid Runtime/runtime.log'), runtimeHistory);
  const launch = path.join(root, 'launch.py');
  writeFileSync(launch, `import json, os, pathlib\nr=pathlib.Path(os.environ['ROOT'])\np=r/'attempts'\nn=int(p.read_text())+1 if p.exists() else 1\np.write_text(str(n))\nmessages=json.loads(os.environ['FAILURES'])\n(r/'logs/editor.log').write_text(messages[min(n-1,len(messages)-1)]+'\\n')\nprint(os.getppid())\n`);
  const ready = path.join(root, 'readiness');
  writeFileSync(ready, '#!/bin/sh\n[ "$1" = -c ] && exit 1\n[ "$(cat "$ROOT/attempts")" -ge "$SUCCESS_AT" ]\n', { mode: 0o700 });
  const source = readFileSync(tool, 'utf8');
  const start = source.indexOf('# The installer-started Runtime left its owner identity');
  const end = source.indexOf('\nrecord_runtime\n\nprintf ', start);
  assert.ok(start >= 0 && end > start, 'test must execute the complete actual startup loop');
  const prelude = `set -Eeuo pipefail\nROOT=${quote(root)}; export ROOT\nLOGS="$ROOT/logs"; STATE="$ROOT/state"; DATA="$ROOT/data"; APP="$ROOT/editor"\nSCRIPT_DIR=${quote(path.dirname(tool))}\nPYTHON=${quote(ready)}; NODE_BIN=/usr/bin; APP_PORT=2400; PROXY_PORT=17500; bootstrap_work="$ROOT/bootstrap"\nFAILURES=${quote(JSON.stringify(failures))}; SUCCESS_AT=${successAt}; export FAILURES SUCCESS_AT\nfail() { echo "STOP: $*" >&2; exit 1; }\nsay() { echo "$*"; }\nstragglers() { :; }\nstop_stack() { echo stop >> "$ROOT/stops"; }\nclean_env() { /usr/bin/python3 ${quote(launch)}; }\nrecord() { printf '%s\\t%s\\tfixture\\n' "$1" "$2"; }\n`;
  const result = spawnSync('bash', ['-c', prelude + source.slice(start, end)], {
    encoding: 'utf8', timeout: 15_000,
  });
  if (result.error) throw result.error;
  const read = (name) => existsSync(path.join(root, name)) ? readFileSync(path.join(root, name), 'utf8') : '';
  return { ...result, output: result.stdout + result.stderr, attempts: Number(read('attempts')), stops: read('stops').trim().split('\n').filter(Boolean).length, read };
}

test('RB-9: an unrelated readiness failure is refused after exactly one start', (t) => {
  const r = startup(t, { failures: ['Runtime failed: incompatible workspace schema'] });
  assert.notEqual(r.status, 0, r.output);
  assert.equal(r.attempts, 1, r.output);
  assert.equal(r.stops, 0, 'no retry may clear owner records after an unrelated failure');
  assert.match(r.read('logs/start-attempt-1.log'), /incompatible workspace schema/);
});

test('RB-9: the exact verification failure gets a counted WARNING and can recover', (t) => {
  const r = startup(t, { failures: [`Runtime failed: ${known}`, 'ready'], successAt: 2 });
  assert.equal(r.status, 0, r.output);
  assert.equal(r.attempts, 2);
  assert.equal(r.stops, 1);
  assert.match(r.output, /WARNING.*retry 1\/2/);
  assert.match(r.read('logs/start-attempt-1.log'), /accepted commit inputs changed during verification/);
});

test('RB-9: an old verification message cannot authorize a new unrelated retry', (t) => {
  const r = startup(t, { runtimeHistory: `Runtime failed: ${known}\n`, failures: ['Runtime failed: unrelated first-start failure'] });
  assert.notEqual(r.status, 0, r.output);
  assert.equal(r.attempts, 1, r.output);
  assert.equal(r.stops, 0);
  assert.doesNotMatch(r.read('logs/start-attempt-1.log'), /accepted commit inputs changed during verification/);
});

test('RB-9: repeated verification failure never exceeds two retries and retains every tail', (t) => {
  const r = startup(t, { failures: [`Runtime failed: ${known}`] });
  assert.notEqual(r.status, 0, r.output);
  assert.equal(r.attempts, 3);
  assert.equal(r.stops, 2);
  for (let attempt = 1; attempt <= 3; attempt += 1) {
    assert.match(r.read(`logs/start-attempt-${attempt}.log`), /accepted commit inputs changed during verification/);
  }
});
