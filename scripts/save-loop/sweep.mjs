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

const usage = 'Usage: node scripts/save-loop/sweep.mjs --manifest FILE --results FILE --versions FILE [--broken-probe|--broken-probe-only] [--reduced-opening] [--quick]';
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
const quick = args.includes('--quick');
const quickWarmReload = args.includes('--quick-warm-reload');
if (quickWarmReload && !quick) throw new Error('--quick-warm-reload requires --quick');
const runtimeStartupPath = args.includes('--runtime-startup') ? flag('--runtime-startup') : null;
if (runtimeStartupPath && !quick) throw new Error('--runtime-startup is only valid with --quick');
if (quick && (probeOnly || args.includes('--broken-probe') || args.includes('--broken-probe-only'))) throw new Error('--quick cannot be combined with broken probes');
if (reducedOpening && (probeOnly || args.includes('--broken-probe'))) throw new Error('--reduced-opening cannot be combined with broken probes');
const manifestPath = flag('--manifest');
const resultsPath = flag('--results');
const versionsPath = flag('--versions');
const fixture = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
const heavyQuickFixture = fixture.variant === 'v30' || fixture.measurement?.label === 'heavy seed history, worst case';
if (quickWarmReload && !heavyQuickFixture) throw new Error('--quick-warm-reload is reserved for the heavy v30 fixture');
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
const {createRecorder, publicSnapshot} = await import('./assert.mjs');
const {expectedFixtureIds, sameIds} = await import('./readiness.mjs');
const quickTools = quick ? await import('./quick.mjs') : null;
const runtimeStartup = runtimeStartupPath ? JSON.parse(fs.readFileSync(runtimeStartupPath, 'utf8')) : null;
if (runtimeStartup && (runtimeStartup.type !== 'runtime_startup' || runtimeStartup.measurement !== 'runtime_start_launch_to_first_authenticated_complete_subsecond_metadata'))
  throw new Error('--runtime-startup does not contain a valid Runtime startup clock record');
let browser;
let provisionalSeen=false, probePromise, postOpenObservation;
const record = value => {
  if (value?.type === 'post_open_blocked') postOpenObservation = value;
  fs.appendFileSync(resultsPath, JSON.stringify(value)+'\n');
};
const round4 = reducedOpening || quick ? await import('./round4.mjs') : null;
for (const [signal, code] of [['SIGINT', 130], ['SIGTERM', 143]]) {
  process.once(signal, async () => {
    try { if (browser) await browser.close(); } finally { process.exit(code); }
  });
}
let failed = false;
const rows = [];
let quickRowWritten=false;
try {
  const {b, p: page, context, cpu, opening, startup, measureWarmOpening, quickBaseline, quickMarker, quickProject} = await helpers.open({
    fixture:probeOnly ? undefined : fixture, reducedOpening:reducedOpening&&!quick, quickOpening:quick, onCleanup: close => { browser = {close}; },
    onProvisional: reducedOpening || quick ? ({warm, value, page, startup, marker}) => {
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
  let secondPage;
  const readStartup = (phase, operation) => startup ? startup.read(phase, operation) : operation();
  const project = quick ? quickProject : await readStartup('project', () => page.evaluate(async projectId => {
    const response = await fetch(`/api/runtime/v1/projects/${encodeURIComponent(projectId)}`, {credentials:'same-origin', cache:'no-store'});
    if (!response.ok) throw new Error(`sandbox project read failed (${response.status})`);
    const body = await response.json(); return body?.data ?? body;
  }, fixture.project_id));
  if (project.project_id !== fixture.project_id || project.metadata?.purpose !== 'synthetic Plan 77 save-loop fixture')
    throw new Error('project is not the synthetic Plan 77 sandbox fixture');
  fs.appendFileSync(resultsPath, JSON.stringify({type:'run', variant:fixture.variant || 'standard', date:new Date().toISOString(), versions, project_id:fixture.project_id, timeline_id:fixture.timeline_id, manifest:manifestPath}) + '\n');
  if (opening && quick) {
    record({...opening, baseline_captured_before_navigation:true, pre_open_head:{revision:quickBaseline.headRevision,publication:quickBaseline.publicationId,exact_clip_ids:sameIds(quickBaseline.clipIds,expectedFixtureIds(fixture))}});
  } else if (opening) {
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
  if (reducedOpening && !quick) {
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
  const emptyFixture = (fixture.measurement?.clip_count ?? expectedFixtureIds(fixture).length) === 0;
  const recorder = await createRecorder(page, {fixture, baseUrl, resultsPath, allowEmpty:probeOnly || emptyFixture, initialSnapshot:quick ? quickBaseline : null});
  let descriptors = [];
  if (!probeOnly) {
    if (!reducedOpening && !quick) {
    secondPage = await context.newPage();
    await secondPage.setViewportSize({width:1700, height:1500});
    await secondPage.goto(helpers.URL_);
    }
    const {editScenarios, repeatScenarios, quickTrackRenameScenario} = await import('./edits.mjs');
    const {dropScenarios} = await import('./drops.mjs');
    const {clashScenario} = await import('./clash.mjs');
    const contextArgs = {page, fixture, helpers};
    const edits = await editScenarios(contextArgs);
    descriptors = quick ? [] : reducedOpening ? edits.filter(d => ['video-move-same-track','audio-move-same-track','audio-mute'].includes(d.name)) : [
      ...edits,
      ...await repeatScenarios(contextArgs),
      ...await dropScenarios(contextArgs),
      await clashScenario({...contextArgs, secondPage}),
    ];
    if (reducedOpening && !quick) {
      const names=descriptors.map(d=>d.name);
      if (names.length!==3 || new Set(names).size!==3) throw new Error('reduced descriptor inventory is incomplete');
      record({type:'reduced_matrix', names, repetitions:3, limitation:'Reduced opening sample; the full 85-scenario matrix remains unfinished.'});
    }
    if (quick) {
      const target = emptyFixture ? quickTrackRenameScenario(fixture) : edits.find(d => d.name === 'video-move-same-track');
      if (!target) throw new Error('quick fixture lacks a supported same-track move or empty-track rename target');
      descriptors = [{...target,measureSaveTimings:true,timeoutMs:60000}];
      record({type:'quick_matrix', names:[target.name], repetitions:2, arms:['immediate_after_cold_open','after_subsecond_read'], cleanup:'guarded_public_undo_between_arms'});
    }
  }
  let quickImmediate=null, quickQuiet=null, quickImmediateClean=false, quickQuietClean=false;
  if (quick) {
    const descriptor=descriptors[0];
    const runArm=async armName => {
      const row=await recorder.runRow({...descriptor,iteration:armName});
      row.quick_arm=armName;
      rows.push(row);
      if (row.pass!==true) failed=true;
      let cleanup=null, cleanupError=null;
      try {
        if (row.pass===true) cleanup=await round4.undoCleanup({page,fixture,baseUrl,result:row,allowEmpty:emptyFixture});
        else {
          const snapshot=await publicSnapshot(page,baseUrl,fixture,{allowEmpty:emptyFixture});
          const clean=Boolean(row.before && row.after && snapshot.headRevision===row.before.headRevision && snapshot.publicationId===row.before.publicationId && snapshot.content_digest===row.public_snapshot?.before?.content_digest && snapshot.payload_digest===row.public_snapshot?.before?.payload_digest);
          if (!clean) throw new Error(`${armName} did not save and fixture cleanliness could not be verified`);
          cleanup={changed:false, unchanged_public_head_verified:true};
        }
      } catch (error) { cleanupError=String(error?.message||error); }
      record({type:'quick_arm',arm:armName,result:row,cleanup,cleanup_error:cleanupError});
      return {row,clean:!cleanupError && (cleanup?.changed===true || cleanup?.unchanged_public_head_verified===true),cleanupError};
    };
    const first=await runArm('immediate_after_cold_open');
    quickImmediate=first.row; quickImmediateClean=first.clean;
    if (quickImmediateClean) {
      try { await probePromise; }
      catch (error) { record({type:'quick_quiet_skipped',reason:'post-open read gate did not produce a subsecond response',detail:String(error?.message||error)}); }
      if (postOpenObservation?.outcome==='available' && quickImmediateClean) {
        const second=await runArm('after_subsecond_read');
        quickQuiet=second.row;
        quickQuietClean=second.clean;
      } else if (!postOpenObservation) record({type:'quick_quiet_skipped',reason:'post-open read result was not observed'});
    } else record({type:'quick_quiet_skipped',reason:first.cleanupError || 'immediate arm cleanup was not verified'});
    if (quickWarmReload) {
      if (!quickImmediateClean || (quickQuiet && !quickQuietClean)) {
        record({type:'quick_warm_opening',outcome:'unobserved',reason:'quick arm cleanup was not authoritatively verified'});
      } else {
        try {
          const cleanBeforeWarm=await publicSnapshot(page,baseUrl,fixture);
          if (!sameIds(cleanBeforeWarm.clipIds,expectedFixtureIds(fixture)) || cleanBeforeWarm.content_digest!==quickBaseline.content_digest || cleanBeforeWarm.payload_digest!==quickBaseline.payload_digest)
            throw new Error('authoritative post-Undo snapshot does not match the pre-open fixture content');
          const warm=await measureWarmOpening(true);
          const afterWarm=await publicSnapshot(page,baseUrl,fixture);
          const preserved=afterWarm.headRevision===cleanBeforeWarm.headRevision && afterWarm.publicationId===cleanBeforeWarm.publicationId &&
            afterWarm.content_digest===cleanBeforeWarm.content_digest && afterWarm.payload_digest===cleanBeforeWarm.payload_digest && sameIds(afterWarm.clipIds,expectedFixtureIds(fixture));
          const warmOutcome=preserved&&warm.first_usable_ms!=null?'available':'unobserved';
          record({...warm,type:'quick_warm_opening',outcome:warmOutcome,
            authoritative_cleanup_before_reload:true,clean_head:{revision:cleanBeforeWarm.headRevision,publication:cleanBeforeWarm.publicationId},
            public_head_preserved_after_reload:preserved,
            reason:preserved?null:'warm reload changed or failed to preserve the authoritative clean public head',
            limitation:'Optional same-profile heavy-fixture reload after guarded Undo; it starts only after the immediate and quiet arms.'});
          if (!preserved) failed=true;
        } catch(error) { record({type:'quick_warm_opening',outcome:'unobserved',reason:String(error?.message||error)}); failed=true; }
      }
    }
    descriptors=[];
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
    for (let iteration=1; iteration<=(quick ? 1 : 3); iteration++) {
      let row;
      const scenarioStart=cpu?.mark();
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
      if (cpu) fs.appendFileSync(resultsPath, JSON.stringify({type:'cpu', name:descriptor.name, iteration, ...cpu.delta(scenarioStart,'scenario')})+'\n');
      const cleanupStart=cpu?.mark();
      try {
        const cleanup = reducedOpening ? await round4.undoCleanup({page, fixture, baseUrl, result:row}) : await descriptor.cleanup({page, secondPage, fixture, helpers, result:row});
        fs.appendFileSync(resultsPath, JSON.stringify({type:'cleanup', name:descriptor.name, iteration, result:cleanup ?? null, cpu:cpu?.delta(cleanupStart,'cleanup') ?? null}) + '\n');
        if (!firstAcceptedReported && descriptor.expected === 'saved' && row?.pass === true && cleanup?.changed === true) {
          fs.appendFileSync(resultsPath, JSON.stringify({type:'first_accepted_scenario', name:descriptor.name, iteration, gesture_to_saved_ms:row.ms, restored_content_verified:true, limitation:'Ordinary matrix row after opening; not part of cold-open timing or CPU.'})+'\n');
          firstAcceptedReported = true;
        }
      } catch (error) {
        const failure = {type:'cleanup_failure', name:descriptor.name, iteration, error:String(error?.message || error), cpu:cpu?.delta(cleanupStart,'cleanup') ?? null};
        fs.appendFileSync(resultsPath, JSON.stringify(failure) + '\n');
        throw new Error(`cleanup failed for ${descriptor.name}: ${failure.error}`);
      }
    }
    if (descriptor.expected === 'saved') {
      const durations = measurements.map(row => row.ms);
      const valid = durations.length === (quick ? 1 : 3) && durations.every(Number.isFinite);
      const sorted = [...durations].sort((a,b)=>a-b);
      const timingPass = quick ? valid && durations[0] <= 10000
        : valid && sorted[1] <= 2000 && sorted[2] <= 4000;
      const summary = {type:'scenario_summary', name:descriptor.name, durations_ms:durations, median_ms:valid ? (quick ? sorted[0] : sorted[1]) : null, timing_pass:timingPass};
      fs.appendFileSync(resultsPath, JSON.stringify(summary) + '\n');
      if (!timingPass) failed = true;
    }
  }
  if (typeof recorder.finish === 'function') await recorder.finish();
  if (quick && opening) {
    const usable = opening.first_usable_ms == null ? null : opening.first_usable_ms / 1000;
    const size = fixture.measurement?.clip_count ?? fixture.clips?.count ?? null;
    const largeRestored = size === 300 && fixture.measurement?.accepted_prefix_clip_count === 300;
    const row = quickTools.quickIndicatorRow({
      size, label:largeRestored || fixture.variant === 'v30' || fixture.measurement?.label === 'heavy seed history, worst case' ? 'heavy seed history, worst case' : `${size ?? 'unknown'} clips`,
      usableSeconds:usable,
      blockedSeconds:postOpenObservation?.post_open_blocked_s ?? null,
      immediateSave:quickImmediate ? quickTools.quickSaveValue(quickImmediate,quickImmediateClean) : {reason:'not observed'},
      quietSave:quickQuiet ? quickTools.quickSaveValue(quickQuiet,quickQuietClean) : {reason:quickImmediateClean?'quiet arm not observed':'blocked by unverified immediate cleanup'},
    });
    record(row);
    quickRowWritten=true;
    console.log('\nPlan 77 quick indicator (single fixture invocation)\n' + quickTools.formatQuickTable([row]));
  }
} catch (error) {
  failed = true;
  console.error(`save-loop: ${error.message}`);
} finally {
  if ((reducedOpening || quick) && !provisionalSeen) record({type:'post_open_blocked', post_open_blocked_s:null, attempts:0, outcome:'missing_ui_marker'});
  if (browser) await browser.close();
  if (probePromise) await probePromise.catch(()=>{});
  if (quick && !quickRowWritten) {
    const size=fixture.measurement?.clip_count??fixture.clips?.count??null;
    const label=size===300&&fixture.measurement?.accepted_prefix_clip_count===300?'heavy seed history, worst case':`${size??'unknown'} clips`;
    const row=quickTools.quickIndicatorRow({size,label,usableSeconds:null,blockedSeconds:postOpenObservation?.post_open_blocked_s??null,immediateSave:{reason:'opening or immediate arm did not complete'},quietSave:{reason:'quiet arm not attempted'}});
    record(row);
    console.log('\nPlan 77 quick indicator (single fixture invocation)\n'+quickTools.formatQuickTable([row]));
  }
  console.table(rows.map(row => ({scenario:row.name, run:row.iteration, pass:row.pass, ms:row.ms, reason:row.reason || row.error})));
}
if (failed) process.exitCode = 1;
