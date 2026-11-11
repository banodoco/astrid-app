import assert from 'node:assert/strict';
import { after, before, test } from 'node:test';
import { createServer } from 'node:http';
import { spawn } from 'node:child_process';
import { mkdtemp, mkdir, rm, access } from 'node:fs/promises';
import { join } from 'node:path';
import { chromium } from '@playwright/test';
import { collectLayoutIssues } from './tour-shot-layout.mjs';
import { readTourSteps } from './tour-shot-metadata.mjs';
import { DEVICE_PROFILES, chromiumExecutable, initialize, parseOptions, renderIndex, run } from './tour-screenshots.mjs';

let browser;
before(async () => { browser = await chromium.launch({ executablePath: chromiumExecutable(), args: ['--no-sandbox'] }); });
after(async () => { await browser?.close(); });

async function check(html, options = {}) {
  const page = await browser.newPage({ viewport: { width: 375, height: 667 } });
  try {
    await page.setContent(`<style>body{margin:0}*{box-sizing:border-box}</style>${html}`);
    return await page.evaluate(collectLayoutIssues, options);
  } finally { await page.close(); }
}

test('flags document and element overflow with selectors and text', async () => {
  const issues = await check('<div id="wide" style="width:500px">Wide content</div>');
  assert(issues.some(issue => issue.type === 'horizontal-overflow' && issue.selector === 'html'));
  assert(issues.some(issue => issue.type === 'horizontal-overflow' && issue.selector === '#wide' && issue.text === 'Wide content'));
});

test('detects clipped text on both axes, excluding scrollable content', async () => {
  const issues = await check('<div id="horizontal" style="width:30px;overflow:hidden;white-space:nowrap">Clipped line of text</div><div id="vertical" style="width:50px;height:10px;overflow:hidden">Several lines of clipped text</div><div id="scroll" style="width:40px;height:20px;overflow:auto">Several lines of scrollable text</div>');
  assert(issues.some(issue => issue.type === 'clipped-text' && issue.selector === '#horizontal' && issue.detail.horizontal));
  assert(issues.some(issue => issue.type === 'clipped-text' && issue.selector === '#vertical' && issue.detail.vertical));
  assert(!issues.some(issue => issue.type === 'clipped-text' && issue.selector === '#scroll'));
});

test('touch targets use CSS dimensions and labelled radio hit areas', async () => {
  const html = '<button id="tiny" style="width:43px;height:44px">Go</button><button id="large" style="width:44px;height:44px">OK</button><label for="radio" style="display:block;width:100px;height:50px"><input id="radio" type="radio">Choice</label><button disabled id="disabled">No</button>';
  const issues = await check(html, { touch: true });
  assert.deepEqual(issues.filter(issue => issue.type === 'small-touch-target').map(issue => issue.selector), ['#tiny']);
  assert(!(await check(html)).some(issue => issue.type === 'small-touch-target'));
});

test('flags card overlaps and viewport violations, including missing targets', async () => {
  const issues = await check('<div id="card" style="position:fixed;left:350px;top:20px;width:100px;height:100px">Card</div><div id="target" style="position:absolute;left:360px;top:50px;width:100px;height:30px">Target</div>', { cardSelector: '#card', targets: ['#target', '#absent'] });
  for (const type of ['card-outside-viewport', 'target-outside-viewport', 'card-target-overlap', 'missing-target']) assert(issues.some(issue => issue.type === type), type);
});

test('target geometry follows clipping ancestors just like the runner', async () => {
  const issues = await check('<div style="position:relative;width:200px;height:50px;overflow:hidden"><div id="row" style="width:2000px;height:30px">Timeline</div></div><div id="card" style="position:fixed;left:240px;top:0;width:100px;height:50px">Card</div>', { cardSelector: '#card', targets: ['#row'] });
  assert(!issues.some(issue => ['target-outside-viewport', 'card-target-overlap'].includes(issue.type)));
});

test('small text is mobile only and hidden, inert, clipped-away nodes are excluded', async () => {
  const html = '<p id="small" style="font-size:11px">Small text</p><p style="font-size:12px">Legible</p><div hidden><p style="font-size:8px">Hidden</p></div><p inert style="font-size:8px">Inert</p><div style="overflow:hidden;width:20px;height:20px"><p style="position:relative;left:100px;font-size:8px">Clipped away</p></div>';
  assert.deepEqual((await check(html, { mobile: true })).filter(issue => issue.type === 'small-text').map(issue => issue.selector), ['#small']);
  assert(!(await check(html)).some(issue => issue.type === 'small-text'));
});

test('fixed coverage threshold uses visible area and is strictly over 60 percent', async () => {
  const issues = await check('<div id="large" style="position:fixed;inset:0;height:61vh">Overlay</div><div id="boundary" style="position:fixed;inset:0;height:60vh">Boundary</div><div id="offscreen" style="position:fixed;left:370px;top:0;width:375px;height:667px">Mostly outside</div>');
  assert.deepEqual(issues.filter(issue => issue.type === 'large-fixed-element').map(issue => issue.selector), ['#large']);
});

test('derives a unique, complete path and real target selectors from the beat machine', () => {
  const steps = readTourSteps();
  assert.equal(steps[0].beat, 'welcome');
  assert.equal(steps.at(-1).beat, 'feedback');
  assert.equal(new Set(steps.map(step => step.id)).size, steps.length);
  assert(steps.find(step => step.beat === 'land').targets.some(selector => selector.includes('data-editor-tour-track')));
  assert.equal(steps.filter(step => step.beat === 'respond').length, 1);
  const ids = steps.map(step => step.id);
  assert.equal(ids.indexOf('act2-gallery'), ids.indexOf('act2-land') + 1);
  assert.equal(ids.indexOf('act3-compose'), ids.indexOf('act2-gallery') + 1);
  assert.deepEqual(steps.find(step => step.id === 'act2-gallery').targets, ['[data-editor-tour="generations-pane"]']);
});

test('profiles preserve descriptor touch/DPR with the requested viewport sizes', () => {
  assert.equal(Object.keys(DEVICE_PROFILES).length, 7);
  for (const [name, profile] of Object.entries(DEVICE_PROFILES)) {
    assert.equal(profile.hasTouch, name !== 'desktop');
    assert.equal(profile.isMobile, name !== 'desktop');
    assert(profile.deviceScaleFactor >= 1);
    assert.deepEqual(profile.screen, profile.viewport);
  }
  assert.deepEqual(DEVICE_PROFILES['ipad-mini-portrait'].viewport, { width: 744, height: 1133 });
});

test('flags reject bad input before launching any services', () => {
  assert.deepEqual(parseOptions(['--devices=iphone-15,desktop', '--themes', 'light']).devices, ['iphone-15', 'desktop']);
  for (const args of [['--devices', 'wat'], ['--themes', 'sepia'], ['--out'], ['--wat'], ['--base-url', 'https://example.com']]) assert.throws(() => parseOptions(args));
});

test('contact sheet contains theme switches, image links, statuses and escaped findings', () => {
  const html = renderIndex({ themes: ['light', 'dark'], devices: [{ name: 'phone', profile: { viewport: { width: 375, height: 667 } } }], steps: [{ id: 'welcome' }], determinism: { time: 'fixed' }, results: [{ device: 'phone', theme: 'light', step: 'welcome', status: 'captured', viewport: 'phone/01.png', fullPage: 'phone/01-full.png', issues: [{ type: 'small-text', selector: '#tiny', text: '<script>' }] }, { device: 'phone', theme: 'dark', step: 'welcome', status: 'skipped', reason: 'Phone only' }] });
  for (const text of ['data-select="dark"', 'data-theme="dark" hidden', 'href="phone/01.png"', 'href="phone/01-full.png"', 'captured · 1 issues', '&lt;script&gt;', 'Phone only']) assert(html.includes(text), text);
});

test('full-page checks include text below the viewport and preserve aria-hidden visuals', async () => {
  const html = '<div aria-hidden="true" id="veil" style="position:fixed;inset:0">Visual veil</div><div style="height:800px"></div><p id="below" style="font-size:10px">Below the fold</p>';
  const viewport = await check(html, { mobile: true });
  assert(!viewport.some(issue => issue.selector === '#below'));
  const full = await check(html, { mobile: true, fullPage: true });
  assert(full.some(issue => issue.type === 'small-text' && issue.selector === '#below'));
  assert(full.some(issue => issue.type === 'large-fixed-element' && issue.selector === '#veil'));
});

test('welcome geometry checks the complete card surrounding the heading', async () => {
  const issues = await check('<div id="welcome" style="position:absolute;left:340px;width:100px"><div><header><h1>Hello</h1></header></div></div>', { cardSelector: 'welcome-card' });
  assert(issues.some(issue => issue.type === 'card-outside-viewport' && issue.selector === '#welcome'));
});

test('fresh contexts receive frozen Date, repeatable randomness and the real theme preference', async () => {
  const samples = [];
  for (let index = 0; index < 2; index++) {
    const context = await browser.newContext({ locale: 'en-US', timezoneId: 'UTC' });
    try {
      await context.addInitScript(initialize, { theme: 'dark', time: '2026-01-15T12:00:00.000Z' });
      await context.route('http://tour.test/**', route => route.fulfill({ contentType: 'text/html', body: '<h1>Fixture</h1>' }));
      const page = await context.newPage();
      await page.goto('http://tour.test/');
      samples.push(await page.evaluate(() => ({ now: Date.now(), date: new Date().toISOString(), explicit: new Date(0).getTime(), parsed: Date.parse('2026-01-15T12:00:00.000Z'), called: Date(), random: Array.from({ length: 5 }, () => Math.random()), theme: localStorage.getItem('theme-hour') })));
    } finally { await context.close(); }
  }
  assert.deepEqual(samples[0], samples[1]);
  assert.equal(samples[0].date, '2026-01-15T12:00:00.000Z');
  assert.equal(samples[0].explicit, 0);
  assert.equal(samples[0].now, samples[0].parsed);
  assert.equal(samples[0].theme, '0');
});

test('includes rendered SVG overflow and small text, excluding SVG definitions', async () => {
  const issues = await check('<svg id="wide-svg" width="500" height="50"><text id="svg-text" y="20" style="font-size:10px">Small label</text><defs><text style="font-size:8px">Definition</text></defs></svg>', { mobile: true });
  assert(issues.some(issue => issue.type === 'horizontal-overflow' && issue.selector === '#wide-svg'));
  assert.deepEqual(issues.filter(issue => issue.type === 'small-text').map(issue => issue.selector), ['#svg-text']);
});

test('runner saves failure evidence, checks its layout, continues devices and leaves the reused server running', async () => {
  const server = createServer((_request, response) => {
    response.setHeader('Content-Type', 'text/html');
    response.end('<h1>Astrid could not start</h1><button id="tiny" style="width:20px;height:20px">Reload</button>');
  });
  await new Promise(done => server.listen(0, '127.0.0.1', done));
  await mkdir('test-results', { recursive: true });
  const out = await mkdtemp(join(process.cwd(), 'test-results', 'tour-shot-fixture-'));
  const base = `http://127.0.0.1:${server.address().port}`;
  try {
    const result = await run(parseOptions(['--base-url', base, '--devices', 'iphone-15,desktop', '--themes', 'light', '--out', out]));
    assert.equal(result.failed, true);
    const failed = result.report.results.filter(row => row.status === 'failed');
    assert.equal(failed.length, 2);
    assert(failed[0].issues.some(issue => issue.type === 'small-touch-target' && issue.selector === '#tiny'));
    for (const row of failed) await access(join(out, row.viewport));
    await assert.rejects(access(join(out, '.server')));
    assert.equal((await fetch(base)).status, 200);
  } finally {
    await new Promise(done => server.close(done));
    await rm(out, { recursive: true, force: true });
  }
});

test('SIGINT preserves a report and removes owned server files', { timeout: 20_000 }, async () => {
  const server = createServer((_request, response) => { response.setHeader('Content-Type', 'text/html'); response.end('<p>Still loading</p>'); });
  await new Promise(done => server.listen(0, '127.0.0.1', done));
  const out = await mkdtemp(join(process.cwd(), 'test-results', 'tour-shot-interrupt-'));
  const child = spawn(process.execPath, ['scripts/tour-screenshots.mjs', '--base-url', `http://127.0.0.1:${server.address().port}`, '--devices', 'desktop', '--themes', 'light', '--out', out], { stdio: ['ignore', 'pipe', 'ignore'] });
  const exited = new Promise(done => child.once('exit', code => done(code)));
  try {
    await new Promise((done, reject) => {
      child.once('error', reject);
      child.stdout.on('data', chunk => { if (chunk.toString().includes('walking')) done(); });
    });
    child.kill('SIGINT');
    assert.notEqual(await exited, 0);
    await assert.rejects(access(join(out, '.server')));
    await access(join(out, 'report.json'));
    await access(join(out, 'index.html'));
  } finally {
    if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
    await new Promise(done => server.close(done));
    await rm(out, { recursive: true, force: true });
  }
});

test('deterministic initialization also works in sandboxed scene frames without storage', async () => {
  const context = await browser.newContext();
  const errors = [];
  try {
    await context.addInitScript(initialize, { theme: 'light', time: '2026-01-15T12:00:00.000Z' });
    await context.route('http://tour.test/**', route => route.fulfill({ contentType: 'text/html', body: '<iframe sandbox="allow-scripts" srcdoc="<h1>Scene fixture</h1>"></iframe>' }));
    const page = await context.newPage();
    page.on('pageerror', error => errors.push(error.message));
    await page.goto('http://tour.test/');
    const frame = page.frames().find(frame => frame.parentFrame());
    assert.equal(await frame.evaluate(() => new Date().toISOString()), '2026-01-15T12:00:00.000Z');
    assert.deepEqual(errors, []);
  } finally { await context.close(); }
});
