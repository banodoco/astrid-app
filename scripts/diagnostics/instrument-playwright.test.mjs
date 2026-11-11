import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, copyFileSync, cpSync, readFileSync, writeFileSync, rmSync } from 'node:fs';
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
  assert.ok(records.every(r => Object.keys(r).every(k => ['event','process','seq','invalid','session','request','route','object','guid','hit'].includes(k))));
});


test('diagnostic verifier rejects collisions and missing joins', () => {
  const dir = mkdtempSync(join(tmpdir(), 'r12-pw-log-'));
  try {
    const file = join(dir, 'log');
    const verify = resolve('scripts/diagnostics/verify-playwright-log.mjs');
    const scannerRows = [
      'TOKEN_SNIFF '+JSON.stringify({event:'request', process:4, scanner:5, request:6}),
      'TOKEN_SNIFF '+JSON.stringify({event:'protocol-join', process:4, scanner:5, request:6, protocol:3}),
      'TOKEN_SNIFF '+JSON.stringify({event:'gate-entry', process:4, scanner:5, request:6}),
    ];
    const check = (events, ok) => {
      const records = events.map((row, i) => 'PW_R12 '+JSON.stringify({ process:1, seq:i + 1, ...row }));
      writeFileSync(file, [...records, ...scannerRows].join('\n'));
      assert.equal(run(process.execPath, [verify, file]).status === 0, ok);
    };
    const start = {event:'observer-start'}, end = {event:'observer-end', invalid:0};
    const made = {event:'created', object:2, request:9, route:10, session:11};
    const dispatcher = {event:'dispatcher', object:2, guid:3};
    const sent = {event:'will-send', request:9, session:11};
    const paused = {event:'paused', request:9, route:10, session:11};
    check([start, sent, paused, made, dispatcher, end], true);
    check([start, paused, made, dispatcher, end], false);
    check([start, sent, made, dispatcher, end], false);
    check([start, sent, paused, {...paused, route:20}, made, dispatcher, end], true);
    check([start, sent, paused, paused, made, dispatcher, end], false);
    check([start, dispatcher, end], false);
    check([start, sent, paused, made, made, dispatcher, end], false);
    check([start, sent, {...made, route:0}, dispatcher, end], false);
    check([start, sent, paused, made, dispatcher], false);
    check([start, sent, paused, made, dispatcher, {...end, invalid:1}], false);
    check([start, sent, paused, made, dispatcher, {event:'collision'}, end], false);
    check([start, sent, paused, made, dispatcher, dispatcher, end], false);
    const gap = [{...start, seq:1}, {...made, seq:3}, {...dispatcher, seq:4}, {...end, seq:5}];
    writeFileSync(file, [...gap.map(row => 'PW_R12 '+JSON.stringify({process:1, ...row})), ...scannerRows].join('\n'));
    assert.notEqual(run(process.execPath, [verify, file]).status, 0);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('navigation-invalidated Fetch.failRequest keeps Playwright abort outcome', () => {
  const executable = process.env.R12_CHROMIUM_EXECUTABLE;
  assert.ok(executable);
  const program = `
    const {chromium} = require(${JSON.stringify(source)});
    (async () => {
      const browser = await chromium.launch({headless:true, executablePath:${JSON.stringify(executable)}});
      const page = await browser.newPage(); await page.goto('data:text/html,ok');
      let held, ready; const gate = new Promise(resolve => ready = resolve);
      await page.route('**/api/**', route => { held = route; ready(); });
      await page.evaluate(() => { void fetch('http://127.0.0.1:1/api/held').catch(() => {}); });
      await gate; await page.goto('data:text/html,other');
      await held.abort().then(() => console.log('ABORT_RESOLVED'), () => console.log('ABORT_REJECTED'));
      await browser.close();
    })().catch(() => process.exitCode = 1);
  `;
  const off = run(process.execPath, ['-e', program], { env: { ...process.env, PW_R12_DIAGNOSTICS: '0' } });
  const on = run(process.execPath, ['-e', program], { env: { ...process.env, PW_R12_DIAGNOSTICS: '1' } });
  assert.equal(off.status, 0); assert.equal(on.status, 0);
  assert.equal(off.stdout.trim(), 'ABORT_RESOLVED');
  assert.equal(on.stdout.trim(), off.stdout.trim());
  assert.match(on.stderr, /"event":"fail-rejected"/);
});


test('observer write failure is sticky without changing Playwright outcomes', () => {
  const executable = process.env.R12_CHROMIUM_EXECUTABLE;
  assert.ok(executable);
  const program = `
    const fs = require('fs'); const original = fs.writeSync; let injected = false;
    fs.writeSync = function(fd, value, ...rest) {
      if (!injected && typeof value === 'string' && value.includes('"event":"will-send"')) { injected = true; throw new Error('observer test failure'); }
      return original.call(this, fd, value, ...rest);
    };
    const {chromium} = require(${JSON.stringify(source)});
    (async () => {
      const browser = await chromium.launch({headless:true, executablePath:${JSON.stringify(executable)}});
      const page = await browser.newPage(); await page.route('**/*', route => route.abort());
      try { await page.goto('http://127.0.0.1:1/'); console.log('UNEXPECTED'); }
      catch { console.log('EXPECTED_FAILURE'); }
      await browser.close();
    })().catch(() => process.exitCode = 1);
  `;
  const result = run(process.execPath, ['-e', program], { env: { ...process.env, PW_R12_DIAGNOSTICS: '1' } });
  assert.equal(result.status, 0);
  assert.equal(result.stdout.trim(), 'EXPECTED_FAILURE');
  const records = result.stderr.split('\n').filter(line => line.startsWith('PW_R12 ')).map(line => JSON.parse(line.slice(7)));
  assert.ok(records.some(r => r.event === 'observer-end' && r.invalid === 1));
  assert.ok(records.some((r, i) => i > 0 && r.seq !== records[i - 1].seq + 1));
  assert.ok(!result.stderr.includes('observer test failure'));
});


test('observer mapping failure is sticky without changing Playwright outcomes', () => {
  const executable = process.env.R12_CHROMIUM_EXECUTABLE;
  assert.ok(executable);
  const dir = mkdtempSync(join(tmpdir(), 'r12-observer-'));
  try {
    cpSync(source, dir, {recursive:true});
    const file = join(dir, 'lib/coreBundle.js');
    const bundle = readFileSync(file, 'utf8');
    const marker = 'const obj = o => {';
    assert.equal(bundle.split(marker).length, 2);
    writeFileSync(file, bundle.replace(marker, marker + ' throw new Error("observer mapping failure");'));
    const program = `
      const {chromium} = require(${JSON.stringify(dir)});
      (async () => {
        const browser = await chromium.launch({headless:true, executablePath:${JSON.stringify(executable)}});
        const page = await browser.newPage(); await page.route('**/*', route => route.abort());
        try { await page.goto('http://127.0.0.1:1/'); console.log('UNEXPECTED'); }
        catch { console.log('EXPECTED_FAILURE'); }
        await browser.close();
      })().catch(() => process.exitCode = 1);
    `;
    const result = run(process.execPath, ['-e', program], { env: { ...process.env, PW_R12_DIAGNOSTICS: '1' } });
    assert.equal(result.status, 0);
    assert.equal(result.stdout.trim(), 'EXPECTED_FAILURE');
    const records = result.stderr.split('\n').filter(line => line.startsWith('PW_R12 ')).map(line => JSON.parse(line.slice(7)));
    assert.ok(records.some(r => r.event === 'observer-end' && r.invalid === 1));
    assert.ok(!result.stderr.includes('observer mapping failure'));
  } finally { rmSync(dir, {recursive:true, force:true}); }
});
