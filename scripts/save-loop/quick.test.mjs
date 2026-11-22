import assert from 'node:assert/strict';
import test from 'node:test';
import {formatQuickTable, quickIndicatorRow, trafficLight} from './quick.mjs';

test('quick indicator applies the accepted limits and keeps missing observations unobserved', () => {
  assert.deepEqual(trafficLight(null, {works:2, slow:10}), {light:'unobserved', seconds:null, reason:'not observed'});
  assert.equal(trafficLight(2, {works:2, slow:10}).light, 'works');
  assert.equal(trafficLight(10, {works:2, slow:10}).light, 'slow');
  assert.equal(trafficLight(10.01, {works:2, slow:10}).light, 'broken');
  assert.equal(trafficLight({refused:true}, {works:2, slow:10}).light, 'broken');
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
