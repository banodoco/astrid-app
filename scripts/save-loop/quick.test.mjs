import assert from 'node:assert/strict';
import test from 'node:test';
import {formatQuickTable, quickIndicatorRow, quickSaveValue, trafficLight} from './quick.mjs';
import {quickTrackRenameScenario} from './edits.mjs';

test('quick indicator applies the accepted limits and keeps missing observations unobserved', () => {
  assert.deepEqual(trafficLight(null, {works:2, slow:10}), {light:'unobserved', seconds:null, reason:'not observed'});
  assert.equal(trafficLight(2, {works:2, slow:10}).light, 'works');
  assert.equal(trafficLight(10, {works:2, slow:10}).light, 'slow');
  assert.equal(trafficLight(10.01, {works:2, slow:10}).light, 'broken');
  assert.equal(trafficLight({refused:true}, {works:2, slow:10}).light, 'broken');
  assert.equal(trafficLight(quickSaveValue({pass:false,reason:'no successful public timeline commit response was observed'}), {works:2,slow:10}).light, 'broken');
});

test('quick row and minute-readable table retain rough numbers and labels', () => {
  const row = quickIndicatorRow({size:300, label:'heavy seed history, worst case', usableSeconds:14.8, blockedSeconds:1.2, immediateSave:{reason:'unsafe to attempt'}, quietSave:2.4});
  assert.equal(row.usable.light, 'slow');
  assert.equal(row.immediate_save.light, 'unobserved');
  assert.equal(row.quiet_save.light, 'slow');
  const table = formatQuickTable([row]);
  assert.match(table, /heavy seed history, worst case/);
  assert.match(table, /slow 14\.8s/);
  assert.match(table, /unobserved/);
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
