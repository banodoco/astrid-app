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
import {createRowMarkCapture, recordThrownRow, rowBoundMs, sweepMaxMs, withBound,
  SweepBoundError, CLEANUP_BOUND_MS, CLOSE_BOUND_MS, finishAbortedSweep} from './save-marks.mjs';

const usage = 'Usage: node scripts/save-loop/sweep.mjs --manifest FILE --results FILE --versions FILE [--broken-probe|--broken-probe-only] [--reduced-opening]';
const args = process.argv.slice(2);
if (args.includes('--help') || args.includes('-h')) { console.log(usage); process.exit(0); }
function flag(name) {
  const index = args.indexOf(name);
  const value = args[index + 1];
  if (index < 0 || !value || value.startsWith('--')) throw new Error(`${name} is required. ${usage}`);
  return value;
}
const probeOnly = args.includes('--broken-probe-only');
const reducedOpening = args.includes('--reduced-opening');
if (reducedOpening && (probeOnly || args.includes('--broken-probe'))) throw new Error('--reduced-opening cannot be combined with broken probes');
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
const sweepLimit = sweepMaxMs();
let browser, closePromise, activeRow;
let stopped = false;
let provisionalSeen=false, probePromise;
const record = value => fs.appendFileSync(resultsPath, JSON.stringify(value)+'\n');
const closeBrowser = () => closePromise ??= withBound('browser-close', CLOSE_BOUND_MS, () => browser?.close());
for (const [signal, code] of [['SIGINT', 130], ['SIGTERM', 143]]) {
  process.once(signal, async () => {
    stopped = true;
    if (activeRow) activeRow.capture.cancelled = true;
    try { await closeBrowser(); } finally { process.exit(code); }
  });
}
let failed = false;
const rows = [];
async function runSweep() {
  const helpers = await import('./lib.mjs');
  const {createRecorder, publicSnapshot} = await import('./assert.mjs');
  const {expectedFixtureIds, sameIds} = await import('./readiness.mjs');
  const round4 = reducedOpening ? await import('./round4.mjs') : null;
  if (stopped) return;
  const {b, p: page, context, cpu, opening, startup, measureWarmOpening} = await helpers.open({
    fixture:probeOnly ? undefined : fixture, reducedOpening, onCleanup: close => { browser = {close}; },
    onProvisional: reducedOpening ? ({warm, value, page, startup, marker}) => {
      if (stopped) return;
      record({type:warm ? 'warm_opening_provisional' : 'cold_opening_provisional', full_ui_saved:value, corroborated:false, marker_at:new Date().toISOString(), readiness_budget_ms:900000, limitation:'UI sample only; public head not yet corroborated.'});
      if (!warm) {
        provisionalSeen=true;
        probePromise=round4.postOpenProbe({page, fixture, startup, marker, record});
        // A failure is consumed later, after the original cold corroboration.
        probePromise.catch(()=>{});
      }
    } : undefined,
  });
  browser = b;
  if (stopped) return;
  let secondPage;
  const readStartup = (phase, operation) => startup ? startup.read(phase, operation) : operation();
  const project = await readStartup('project', () => page.evaluate(async projectId => {
    const response = await fetch(`/api/runtime/v1/projects/${encodeURIComponent(projectId)}`, {credentials:'same-origin', cache:'no-store'});
    if (!response.ok) throw new Error(`sandbox project read failed (${response.status})`);
    const body = await response.json(); return body?.data ?? body;
  }, fixture.project_id));
  if (project.project_id !== fixture.project_id || project.metadata?.purpose !== 'synthetic Plan 77 save-loop fixture')
    throw new Error('project is not the synthetic Plan 77 sandbox fixture');
  fs.appendFileSync(resultsPath, JSON.stringify({type:'run', variant:fixture.variant || 'standard', date:new Date().toISOString(), versions, project_id:fixture.project_id, timeline_id:fixture.timeline_id, manifest:manifestPath}) + '\n');
  if (opening) {
    const head = await readStartup('head_after_ui', () => publicSnapshot(page, baseUrl, fixture));
    const idsMatch = sameIds(head.clipIds, expectedFixtureIds(fixture));
    opening.public_head = {project_id:head.project_id, timeline_id:head.timeline_id, revision:head.headRevision, publication:head.publicationId, exact_clip_ids:idsMatch};
    opening.full_ui_and_public_head_match = Boolean(opening.full_ui_saved && idsMatch && opening.head_before_ui.revision === head.headRevision && opening.head_before_ui.publication === head.publicationId);
    opening.full_open_corroborated = opening.full_ui_and_public_head_match;
    opening.full_open_ms = opening.full_open_corroborated ? opening.full_ui_saved.ui_saved_ms : null;
    opening.full_open_target_pass = opening.full_open_ms === null ? null : opening.full_open_ms <= opening.target_full_open_ms;
    opening.full_open_confirmed = false;
    opening.limitation = opening.full_open_corroborated ? 'Exact UI IDs and tracks with sampled stable Saved agree with an unchanged public head and exact clip IDs. The editor does not independently expose its rendered head identity.' : opening.limitation + ' The editor does not independently expose its rendered head identity.';
    fs.appendFileSync(resultsPath, JSON.stringify(opening)+'\n');
    if (!idsMatch) throw new Error('public head clip IDs do not match expected fixture');
  }
  if (reducedOpening) {
    if (!probePromise) throw new Error('stable cold UI marker was not observed');
    await probePromise;
    const warm = await measureWarmOpening(true);
    const warmHead = await readStartup('warm_head_after_ui', () => publicSnapshot(page, baseUrl, fixture));
    const idsMatch=sameIds(warmHead.clipIds, expectedFixtureIds(fixture));
    warm.public_head={project_id:warmHead.project_id, timeline_id:warmHead.timeline_id, revision:warmHead.headRevision, publication:warmHead.publicationId, exact_clip_ids:idsMatch};
    warm.full_open_corroborated=Boolean(warm.full_ui_saved && idsMatch && warm.head_before_ui.revision===warmHead.headRevision && warm.head_before_ui.publication===warmHead.publicationId);
    warm.full_open_ms=warm.full_open_corroborated ? warm.full_ui_saved.ui_saved_ms : null;
    warm.full_open_target_pass=warm.full_open_ms===null ? null : warm.full_open_ms<=warm.target_full_open_ms;
    warm.full_open_confirmed=false;
    warm.limitation='Same-profile reload; rendered head identity is not independently exposed.';
    record(warm);
    if (!idsMatch || !warm.full_open_corroborated || warmHead.headRevision!==opening.public_head.revision || warmHead.publicationId!==opening.public_head.publication) throw new Error('warm opening did not preserve the corroborated cold public head');
  }
  if (stopped) return;
  const recorder = await createRecorder(page, {fixture, baseUrl, resultsPath, allowEmpty:probeOnly});
  if (stopped) return;
  let descriptors = [];
  if (!probeOnly) {
    if (!reducedOpening) {
    secondPage = await context.newPage();
    await secondPage.setViewportSize({width:1700, height:1500});
    await secondPage.goto(helpers.URL_);
    }
    const {editScenarios, repeatScenarios} = await import('./edits.mjs');
    const {dropScenarios} = await import('./drops.mjs');
    const {clashScenario} = await import('./clash.mjs');
    const contextArgs = {page, fixture, helpers};
    const edits = await editScenarios(contextArgs);
    descriptors = reducedOpening ? edits.filter(d => ['video-move-same-track','audio-move-same-track','audio-mute'].includes(d.name)) : [
      ...edits,
      ...await repeatScenarios(contextArgs),
      ...await dropScenarios(contextArgs),
      await clashScenario({...contextArgs, secondPage}),
    ];
    if (reducedOpening) {
      const names=descriptors.map(d=>d.name);
      if (names.length!==3 || new Set(names).size!==3) throw new Error('reduced descriptor inventory is incomplete');
      record({type:'reduced_matrix', names, repetitions:3, limitation:'Reduced opening sample; the full 85-scenario matrix remains unfinished.'});
    }
  }
  if (args.includes('--broken-probe') || probeOnly) descriptors.push({
    name:'deliberately broken no-op probe', expected:'saved', timeoutMs:1000,
    gesture:async()=>{}, cleanup:context=>context.helpers.restoreScenario(context),
  });
  let firstAcceptedReported = false;
  for (const descriptor of descriptors) {
    if (!descriptor || typeof descriptor.name !== 'string' || typeof descriptor.gesture !== 'function' ||
        !['saved','clash'].includes(descriptor.expected) || typeof descriptor.cleanup !== 'function') {
      throw new Error(`invalid scenario descriptor or missing cleanup: ${descriptor?.name || '<unnamed>'}`);
    }
    const measurements = [];
    for (let iteration=1; iteration<=3; iteration++) {
      if (stopped) return;
      let row;
      const capture = createRowMarkCapture(page);
      const currentRow = {name:descriptor.name, iteration, capture};
      activeRow = currentRow;
      const scenarioStart=cpu?.mark();
      try {
        row = await withBound('row', rowBoundMs(descriptor), () => recorder.runRow({...descriptor, iteration}, capture));
        if (stopped) return;
        row = {...row, name:descriptor.name, iteration};
        rows.push(row);
        measurements.push(row);
        if (row?.pass !== true) failed = true;
      } catch (error) {
        if (stopped) return;
        if (error instanceof SweepBoundError) throw error;
        failed = true;
        row = await recordThrownRow(currentRow, error, record);
        if (stopped) return;
        rows.push(row);
        measurements.push(row);
      }
      if (cpu) fs.appendFileSync(resultsPath, JSON.stringify({type:'cpu', name:descriptor.name, iteration, ...cpu.delta(scenarioStart,'scenario')})+'\n');
      const cleanupStart=cpu?.mark();
      try {
        const cleanup = await withBound('cleanup', CLEANUP_BOUND_MS, () => reducedOpening
          ? round4.undoCleanup({page, fixture, baseUrl, result:row})
          : descriptor.cleanup({page, secondPage, fixture, helpers, result:row}));
        if (stopped) return;
        fs.appendFileSync(resultsPath, JSON.stringify({type:'cleanup', name:descriptor.name, iteration, result:cleanup ?? null, cpu:cpu?.delta(cleanupStart,'cleanup') ?? null}) + '\n');
        if (!firstAcceptedReported && descriptor.expected === 'saved' && row?.pass === true && cleanup?.changed === true) {
          fs.appendFileSync(resultsPath, JSON.stringify({type:'first_accepted_scenario', name:descriptor.name, iteration, gesture_to_saved_ms:row.ms, restored_content_verified:true, limitation:'Ordinary matrix row after opening; not part of cold-open timing or CPU.'})+'\n');
          firstAcceptedReported = true;
        }
      } catch (error) {
        if (stopped) return;
        const failure = {type:'cleanup_failure', name:descriptor.name, iteration, error:String(error?.message || error), cpu:cpu?.delta(cleanupStart,'cleanup') ?? null};
        fs.appendFileSync(resultsPath, JSON.stringify(failure) + '\n');
        if (error instanceof SweepBoundError) throw error;
        throw new Error(`cleanup failed for ${descriptor.name}: ${failure.error}`);
      }
      activeRow = undefined;
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
}

try {
  // Includes imports, opening, setup, every row and cleanup, recorder.finish,
  // browser close and the reduced-opening probe, not just the scenario loop.
  await withBound('sweep', sweepLimit, async () => {
    try {
      await runSweep();
    } catch (error) {
      if (error instanceof SweepBoundError) throw error;
      if (stopped) return;
      failed = true;
      console.error(`save-loop: ${error.message}`);
    }
    if (stopped) return;
    if (reducedOpening && !provisionalSeen) record({type:'post_open_blocked', post_open_blocked_s:null, attempts:0, outcome:'missing_ui_marker'});
    await closeBrowser();
    if (probePromise) await probePromise.catch(()=>{});
  });
} catch (error) {
  stopped = true;
  console.error(`save-loop: ${error.message}`);
  try {
    if (error instanceof SweepBoundError) {
      await finishAbortedSweep(error, {activeRow, record, close:closeBrowser});
    } else {
      await closeBrowser();
    }
  } catch (closeError) {
    console.error(`save-loop abort/close: ${closeError.message}`);
  } finally {
    // Promise.race cannot cancel an in-flight page call. Never let abandoned
    // Playwright requests or probe promises keep this aborted CLI alive.
    process.exit(1);
  }
}
console.table(rows.map(row => ({scenario:row.name, run:row.iteration, pass:row.pass, ms:row.ms, reason:row.reason || row.error})));
if (failed) process.exitCode = 1;
