import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, copyFileSync, readFileSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';

const source = resolve('node_modules/playwright-core');
const patch = resolve('scripts/diagnostics/instrument-playwright.mjs');
const run = (cmd, args, options = {}) => spawnSync(cmd, args, { encoding: 'utf8', ...options });

test('patch rejects altered bundle without modifying it', () => {
  const dir = mkdtempSync(join(tmpdir(), 'r12-pw-'));
  try {
    mkdirSync(join(dir, 'lib'));
    copyFileSync(join(source, 'package.json'), join(dir, 'package.json'));
    const file = join(dir, 'lib/coreBundle.js');
    writeFileSync(file, 'unrecognized');
    const result = run(process.execPath, [patch, file]);
    assert.notEqual(result.status, 0);
    assert.equal(readFileSync(file, 'utf8'), 'unrecognized');
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('opt-in protocol events join without disclosing request contents', () => {
  const executable = process.env.R12_CHROMIUM_EXECUTABLE;
  assert.ok(executable, 'R12_CHROMIUM_EXECUTABLE is required');
  const secret = 'R12_UNIQUE_SENTINEL_92ad8';
  const program = `
    const { chromium } = require(${JSON.stringify(source)});
    const crypto = require('crypto');
    (async () => {
      const browser = await chromium.launch({headless:true, executablePath:${JSON.stringify(executable)}});
      const page = await browser.newPage();
      await page.route('**/*', route => route.abort());
      page.on('request', req => { const id = parseInt(crypto.createHash('sha256').update(req._guid).digest('hex').slice(0,12),16); console.log('JOIN '+id); });
      await page.goto('data:text/html,ok');
      const failed = await page.evaluate(async secret => { try { await fetch('http://127.0.0.1:1/' + secret + '?query=' + secret, {method: 'POST', headers: {'x-secret': secret}, body: secret}); return false; } catch { return true; } }, '${secret}');
      console.log(failed ? 'EXPECTED_FAILURE' : 'UNEXPECTED');
      await browser.close();
    })().catch(() => process.exitCode = 1);
  `;
  const off = run(process.execPath, ['-e', program], { env: { ...process.env, PW_R12_DIAGNOSTICS: '0' } });
  const on = run(process.execPath, ['-e', program], { env: { ...process.env, PW_R12_DIAGNOSTICS: '1' } });
  assert.equal(off.status, 0); assert.equal(on.status, 0);
  assert.match(off.stdout, /EXPECTED_FAILURE/); assert.match(on.stdout, /EXPECTED_FAILURE/);
  assert.doesNotMatch(off.stderr, /PW_R12/);
  assert.ok(!on.stderr.includes(secret));
  const records = on.stderr.split('\n').filter(line => line.startsWith('PW_R12 ')).map(line => JSON.parse(line.slice(7)));
  assert.ok(records.some(r => r.event === 'fail-begin'));
  assert.ok(records.some(r => r.event === 'fail-success'));
  assert.ok(records.some(r => r.event === 'loading-failed' && r.hit === 1));
  assert.ok(!records.some(r => r.event === 'collision'));
  const joined = Number(on.stdout.match(/JOIN (\d+)/)?.[1]);
  const dispatcher = records.find(r => r.event === 'dispatcher' && r.guid === joined);
  assert.ok(dispatcher);
  const created = records.find(r => r.event === 'created' && r.object === dispatcher.object);
  assert.ok(created);
  assert.ok(records.some(r => r.event === 'fail-begin' && r.route === created.route));
  assert.ok(records.some(r => r.event === 'loading-failed' && r.request === created.request));
  assert.ok(records.every(r => Object.keys(r).every(k => ['event','process','session','request','route','object','guid','hit'].includes(k))));
});
