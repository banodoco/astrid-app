/*
 * Plan 77 live save-loop matrix. Run only against the synthetic fixture on the
 * isolated SL-1 stack. Each descriptor is measured three times; its cleanup is
 * required so a later row does not inherit an earlier row's edits.
 *
 * SAVE_LOOP_CHROME=/usr/bin/google-chrome \
 * SAVE_LOOP_PLAYWRIGHT=/opt/node-tools/node_modules/playwright/index.mjs \
 * SAVE_LOOP_BASE_URL=http://127.0.0.1:PORT \
 * node scripts/save-loop/sweep.mjs --manifest /path/to/manifest.json \
 *   --results /path/to/round.jsonl --versions /path/to/versions.json
 *
 * The versions JSON must identify the actual App, Agent and Runtime revisions.
 * Results are appended; choose a new file for each round.
 */
import fs from 'fs';

const usage = 'Usage: node scripts/save-loop/sweep.mjs --manifest FILE --results FILE --versions FILE [--broken-probe|--broken-probe-only]';
const args = process.argv.slice(2);
if (args.includes('--help') || args.includes('-h')) { console.log(usage); process.exit(0); }
function flag(name) {
  const index = args.indexOf(name);
  const value = args[index + 1];
  if (index < 0 || !value || value.startsWith('--')) throw new Error(`${name} is required. ${usage}`);
  return value;
}
const probeOnly = args.includes('--broken-probe-only');
const manifestPath = flag('--manifest');
const resultsPath = flag('--results');
const versionsPath = flag('--versions');
const fixture = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
const versions = JSON.parse(fs.readFileSync(versionsPath, 'utf8'));
if (!fixture.project_id || !fixture.timeline_id || (!probeOnly && (!fixture.tracks || !fixture.clips || !fixture.media)))
  throw new Error('fixture manifest lacks project, timeline, tracks, clips or media');
if (!versions.app || !versions.agent || !versions.runtime)
  throw new Error('versions JSON must identify app, agent and runtime');
if (!process.env.SAVE_LOOP_BASE_URL || !process.env.SAVE_LOOP_CHROME)
  throw new Error('SAVE_LOOP_BASE_URL and SAVE_LOOP_CHROME are required');
if (fs.existsSync(resultsPath)) throw new Error('results file already exists; use a new file for each round');
process.env.SAVE_LOOP_PROJECT = fixture.project_id;
process.env.SAVE_LOOP_TIMELINE = fixture.timeline_id;
const baseUrl = process.env.SAVE_LOOP_BASE_URL;
const origin = new URL(baseUrl);
if (!['localhost','127.0.0.1','[::1]'].includes(origin.hostname)) throw new Error('save-loop requires a local isolated stack');
const helpers = await import('./lib.mjs');
const {createRecorder} = await import('./assert.mjs');
let browser;
let failed = false;
const rows = [];
try {
  const {b, p: page, context} = await helpers.open();
  browser = b;
  let secondPage;
  const project = await page.evaluate(async projectId => {
    const response = await fetch(`/api/runtime/v1/projects/${encodeURIComponent(projectId)}`, {credentials:'same-origin', cache:'no-store'});
    if (!response.ok) throw new Error(`sandbox project read failed (${response.status})`);
    const body = await response.json(); return body?.data ?? body;
  }, fixture.project_id);
  if (project.project_id !== fixture.project_id || project.metadata?.purpose !== 'synthetic Plan 77 save-loop fixture')
    throw new Error('project is not the synthetic Plan 77 sandbox fixture');
  fs.appendFileSync(resultsPath, JSON.stringify({type:'run', date:new Date().toISOString(), versions, project_id:fixture.project_id, timeline_id:fixture.timeline_id, manifest:manifestPath}) + '\n');
  const recorder = await createRecorder(page, {fixture, baseUrl, resultsPath, allowEmpty:probeOnly});
  let descriptors = [];
  if (!probeOnly) {
    secondPage = await context.newPage();
    await secondPage.setViewportSize({width:1700, height:1500});
    await secondPage.goto(helpers.URL_);
    const {editScenarios, repeatScenarios} = await import('./edits.mjs');
    const {dropScenarios} = await import('./drops.mjs');
    const {clashScenario} = await import('./clash.mjs');
    const contextArgs = {page, fixture, helpers};
    descriptors = [
      ...await editScenarios(contextArgs),
      ...await repeatScenarios(contextArgs),
      ...await dropScenarios(contextArgs),
      await clashScenario({...contextArgs, secondPage}),
    ];
  }
  if (args.includes('--broken-probe') || probeOnly) descriptors.push({
    name:'deliberately broken no-op probe', expected:'saved', timeoutMs:1000,
    gesture:async()=>{}, cleanup:context=>context.helpers.restoreScenario(context),
  });
  for (const descriptor of descriptors) {
    if (!descriptor || typeof descriptor.name !== 'string' || typeof descriptor.gesture !== 'function' ||
        !['saved','clash'].includes(descriptor.expected) || typeof descriptor.cleanup !== 'function') {
      throw new Error(`invalid scenario descriptor or missing cleanup: ${descriptor?.name || '<unnamed>'}`);
    }
    const measurements = [];
    for (let iteration=1; iteration<=3; iteration++) {
      let row;
      try {
        row = await recorder.runRow({...descriptor, iteration});
        row = {...row, name:descriptor.name, iteration};
        rows.push(row);
        measurements.push(row);
        if (row?.pass !== true) failed = true;
      } catch (error) {
        failed = true;
        row = {name:descriptor.name, iteration, pass:false, error:String(error?.message || error)};
        rows.push(row);
        measurements.push(row);
        fs.appendFileSync(resultsPath, JSON.stringify({type:'row', ...row}) + '\n');
      }
      try {
        const cleanup = await descriptor.cleanup({page, secondPage, fixture, helpers, result:row});
        fs.appendFileSync(resultsPath, JSON.stringify({type:'cleanup', name:descriptor.name, iteration, result:cleanup ?? null}) + '\n');
      } catch (error) {
        const failure = {type:'cleanup_failure', name:descriptor.name, iteration, error:String(error?.message || error)};
        fs.appendFileSync(resultsPath, JSON.stringify(failure) + '\n');
        throw new Error(`cleanup failed for ${descriptor.name}: ${failure.error}`);
      }
    }
    if (descriptor.expected === 'saved') {
      const durations = measurements.map(row => row.ms);
      const valid = durations.length === 3 && durations.every(Number.isFinite);
      const sorted = [...durations].sort((a,b)=>a-b);
      const timingPass = valid && sorted[1] <= 2000 && sorted[2] <= 4000;
      const summary = {type:'scenario_summary', name:descriptor.name, durations_ms:durations, median_ms:valid ? sorted[1] : null, timing_pass:timingPass};
      fs.appendFileSync(resultsPath, JSON.stringify(summary) + '\n');
      if (!timingPass) failed = true;
    }
  }
  if (typeof recorder.finish === 'function') await recorder.finish();
} catch (error) {
  failed = true;
  console.error(`save-loop: ${error.message}`);
} finally {
  if (browser) await browser.close();
  console.table(rows.map(row => ({scenario:row.name, run:row.iteration, pass:row.pass, ms:row.ms, reason:row.reason || row.error})));
}
if (failed) process.exitCode = 1;
