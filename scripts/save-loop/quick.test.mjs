import assert from 'node:assert/strict';
import test from 'node:test';
import {formatQuickTable, quickIndicatorRow, quickSaveTiming, quickSaveValue, trafficLight} from './quick.mjs';
import {quickTrackRenameScenario} from './edits.mjs';

test('quick indicator applies the accepted limits and keeps missing observations unobserved', () => {
  assert.deepEqual(trafficLight(null, {works:2, slow:10}), {light:'unobserved', seconds:null, reason:'not observed'});
  assert.equal(trafficLight(2, {works:2, slow:10}).light, 'works');
  assert.equal(trafficLight(10, {works:2, slow:10}).light, 'slow');
  assert.equal(trafficLight(10.01, {works:2, slow:10}).light, 'broken');
  assert.equal(trafficLight({refused:true}, {works:2, slow:10}).light, 'broken');
  assert.equal(trafficLight(quickSaveValue({pass:false,reason:'no successful public timeline commit response was observed'}), {works:2,slow:10}).light, 'unobserved');
  assert.equal(quickSaveValue({pass:false,final_badge:{state:'not saved',text:'Runtime rejected commit'},settlement_outcome:'refusal'}).refused,true);
  assert.equal(trafficLight(quickSaveValue({pass:false,final_badge:{state:'not saved',text:'old dirty badge'},settlement_outcome:'dirty_before_gesture'}),{works:2,slow:10}).light,'unobserved');
  assert.equal(trafficLight(quickSaveValue({pass:false,final_badge:{state:'saved'},reason:'fixture setup failed'}),{works:2,slow:10}).light,'unobserved');
  assert.equal(trafficLight(quickSaveValue({pass:false,settlement_outcome:'deadline',settlement_timeout_ms:60000,settlement_elapsed_ms:60015}),{works:2,slow:10}).light,'broken');
  assert.equal(trafficLight(quickSaveValue({pass:false,settlement_outcome:'deadline',settlement_timeout_ms:60000,settlement_elapsed_ms:1200}),{works:2,slow:10}).light,'unobserved');
  assert.equal(trafficLight(quickSaveValue({pass:false,settlement_outcome:'deadline',settlement_timeout_ms:10000}),{works:2,slow:10}).light,'unobserved');
});

test('quick timings pair request to its own response and preserve unconfirmed states', () => {
  const timing=quickSaveTiming([
    {method:'POST',requestAt:1200,responseAt:1245,status:200},
    {method:'POST',requestAt:1300,responseAt:1390,status:200},
  ],1000);
  assert.equal(timing.gesture_to_post_ms,200);
  assert.equal(timing.post_to_response_ms,45);
  assert.equal(timing.outcome,'accepted');
  const unconfirmed=quickSaveTiming([{method:'POST',requestAt:1200,status:null}],1000);
  assert.equal(unconfirmed.gesture_to_post_ms,200);
  assert.equal(unconfirmed.post_to_response_ms,null);
  assert.equal(unconfirmed.outcome,'response_unconfirmed');
  const beforeGesture=quickSaveTiming([{method:'POST',requestAt:990,responseAt:1000,status:200}],1000);
  assert.equal(beforeGesture.gesture_to_post_ms,null);
  assert.equal(beforeGesture.post_to_response_ms,10);
  assert.match(beforeGesture.reason,/preceded/);
  assert.equal(quickSaveTiming([],1000).outcome,'unobserved');
  const refusal=quickSaveTiming([{method:'POST',requestAt:1020,responseAt:1032,status:409}],1000);
  assert.equal(refusal.outcome,'refused');
  assert.equal(quickSaveValue({pass:false,quick_save_timing:refusal}).refused,true);
});

test('quick row and minute-readable table retain rough numbers and labels', () => {
  const timing={gesture_to_post_ms:210,post_to_response_ms:51};
  const row = quickIndicatorRow({size:300, label:'heavy seed history, worst case', usableSeconds:14.8, blockedSeconds:1.2, immediateSave:{reason:'unsafe to attempt',timing}, quietSave:{seconds:2.4,timing}});
  assert.equal(row.usable.light, 'slow');
  assert.equal(row.immediate_save.light, 'unobserved');
  assert.equal(row.immediate_save_timing.reason, 'unsafe to attempt');
  assert.equal(row.quiet_save.light, 'slow');
  assert.deepEqual(row.quiet_save_timing,timing);
  const table = formatQuickTable([row]);
  assert.match(table, /heavy seed history, worst case/);
  assert.match(table, /slow 14\.8s/);
  assert.match(table, /unobserved/);
  assert.match(table, /210 ms/);
  assert.match(table, /51 ms/);
});

test('empty quick arm targets exact V1 through the existing track-name control', async () => {
  const fixture={timeline_id:'p77-empty-a1b2c3d4',tracks:{visual:[{id:'V1'}]}};
  const descriptor=quickTrackRenameScenario(fixture);
  assert.equal(descriptor.name,'track-rename-same-track');
  const calls=[];
  let value='Video 1';
  const field={
    waitFor:async options=>calls.push(['wait',options]), isDisabled:async()=>false,
    getAttribute:async()=>null, inputValue:async()=>value, hover:async()=>calls.push(['hover']),
    fill:async next=>{value=next;calls.push(['fill',next]);}, press:async key=>calls.push(['press',key]),
    blur:async()=>calls.push(['blur']),
  };
  const page={locator:selector=>{calls.push(['selector',selector]);return {first:()=>field};}};
  await descriptor.gesture({page,mark:()=>calls.push(['mark'])});
  const renamed=`Video 1 · quick ${fixture.timeline_id.slice(-8)}`;
  assert.equal(value,renamed);
  assert.ok(calls.some(([kind,selector])=>kind==='selector'&&selector==='[data-track-id="V1"] input[aria-label="Track name"]'));
  assert.equal(descriptor.verify({before:{payload:{tracks:[{id:'V1',label:'Video 1'}]}},after:{payload:{tracks:[{id:'V1',label:renamed}]}}}).pass,true);
  assert.throws(()=>descriptor.verify({before:{payload:{tracks:[{id:'V1',label:'Video 1'}]}},after:{payload:{tracks:[{id:'V1',label:'other'}]}}}),/exact reversible rename/);
});
