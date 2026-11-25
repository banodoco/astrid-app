import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {createRecorder} from './assert.mjs';
import {highestSaveCounter, relativeSaveMarks, createRowMarkCapture, recordThrownRow,
  unavailableSaveMarks, rowBoundMs, sweepMaxMs, withBound, SweepBoundError,
  finishAbortedSweep, CLEANUP_BOUND_MS, CLOSE_BOUND_MS} from './save-marks.mjs';

const mark = (n, phase, startTime) => ({name:`astrid.save.${n}.${phase}`, startTime});
const never = () => new Promise(() => {});
function fakePage(...reads) {
  let count = 0;
  return {
    get calls() { return count; },
    async evaluate() {
      const read = reads[count++];
      return typeof read === 'function' ? read() : read;
    },
  };
}

test('sorts counters, drops old and unrelated marks, rounds relative page times, preserves missing phases', () => {
  const old = [mark(8, 'gesture-end', 20), mark(9, 'post-sent', 30)];
  const entries = [...old, mark(12, 'saved-badge', 150.46), mark(11, 'post-sent', 102),
    mark(12, 'gesture-end', 130.12), mark(12, 'post-sent', 131.28),
    mark(12, '200', 145.23), mark(10, 'gesture-end', 80), mark(10, '200', 100.49),
    {name:'other.900.gesture-end', startTime:1}, mark(999, 'invalid', 100),
    mark(200, 'gesture-end', NaN)];
  assert.equal(highestSaveCounter(old), 9);
  assert.deepEqual(relativeSaveMarks(entries, 9), {marks_available:true, saves:[
    {n:10, gesture_end:0, post_sent:null, ok_200:20.5, saved_badge:null},
    {n:11, gesture_end:null, post_sent:null, ok_200:null, saved_badge:null},
    {n:12, gesture_end:0, post_sent:1.2, ok_200:15.1, saved_badge:20.3},
  ]});
  assert.deepEqual(relativeSaveMarks(old, 9), {marks_available:true, saves:[]});
  assert.deepEqual(relativeSaveMarks([], 0), unavailableSaveMarks());
  assert.deepEqual(relativeSaveMarks(entries, null), unavailableSaveMarks());
});

test('fake page runs the real User Timing collection callback before and after a row', async () => {
  const names = ['astrid.save.1.gesture-end', 'astrid.save.2.gesture-end',
    'astrid.save.2.post-sent', 'astrid.save.2.200', 'irrelevant.mark'];
  let calls = 0;
  const page = {async evaluate(fn) { calls++; return fn(); }};
  try {
    performance.mark(names[0], {startTime:10});
    const capture = createRowMarkCapture(page);
    await capture.start();
    performance.mark(names[1], {startTime:20});
    performance.mark(names[2], {startTime:22.24});
    performance.mark(names[3], {startTime:30.42});
    performance.mark(names[4], {startTime:31});
    assert.deepEqual(await capture.read(), {marks_available:true, saves:[
      {n:2, gesture_end:0, post_sent:2.2, ok_200:10.4, saved_badge:null},
    ]});
    await capture.read();
    assert.equal(calls, 2);
  } finally {
    for (const name of names) performance.clearMarks(name);
  }
});

test('successive rows watermark cleanup saves and builds without marks report unavailable', async () => {
  const first = [mark(1, 'gesture-end', 10)];
  const cleanup = [...first, mark(2, 'gesture-end', 20)];
  const afterSecond = [...cleanup, mark(3, 'gesture-end', 30)];
  const page = fakePage([], first, cleanup, afterSecond, [], []);
  const a = createRowMarkCapture(page);
  await a.start();
  assert.deepEqual((await a.read()).saves.map(s => s.n), [1]);
  const b = createRowMarkCapture(page);
  await b.start();
  assert.deepEqual((await b.read()).saves.map(s => s.n), [3]);
  const absent = createRowMarkCapture(page);
  await absent.start();
  assert.deepEqual(await absent.read(), unavailableSaveMarks());
  assert.equal(page.calls, 6);
});

test('thrown row is recorded once and preserves a partial save', async () => {
  const old = [mark(1, 'gesture-end', 1)];
  const page = fakePage(old, [...old, mark(2, 'gesture-end', 5), mark(2, 'post-sent', 7)]);
  const capture = createRowMarkCapture(page);
  await capture.start();
  const activeRow = {name:'move', iteration:2, capture};
  const records = [];
  const error = new Error('page read failed');
  const first = recordThrownRow(activeRow, error, v => records.push(v));
  const second = recordThrownRow(activeRow, error, v => records.push(v));
  await Promise.all([first, second]);
  assert.deepEqual(records, [{type:'row', name:'move', iteration:2, pass:false,
    error:'page read failed', save_marks:{marks_available:true, saves:[
      {n:2, gesture_end:0, post_sent:2, ok_200:null, saved_badge:null},
    ]}}]);
  assert.equal(capture.cancelled, true);
  assert.equal(capture.recorded, true);
  assert.equal(page.calls, 2);
});

test('a stalled or rejected mark read yields no invented times, and a missing baseline never attributes old marks', async () => {
  const stalled = createRowMarkCapture(fakePage([], never), 10);
  await stalled.start();
  assert.deepEqual(await stalled.read(), unavailableSaveMarks());
  const rejected = createRowMarkCapture(fakePage([], () => {throw new Error('closed');}));
  await rejected.start();
  assert.deepEqual(await rejected.read(), unavailableSaveMarks());
  const unknown = createRowMarkCapture(fakePage(never, [mark(3, 'gesture-end', 12)]), 10);
  await unknown.start();
  assert.deepEqual(await unknown.read(), unavailableSaveMarks());
});

test('runRow records marks even when its own assertions fail before the gesture', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'save-marks-test-'));
  const resultsPath = path.join(dir, 'rows.jsonl');
  let markReads = 0;
  const page = {
    async evaluate(fn) {
      const source = String(fn);
      if (source.includes("getEntriesByType('mark')")) {
        markReads++;
        return [mark(1, 'gesture-end', 10)];
      }
      if (source.includes('wall: Date.now()')) return {wall:1, page:1};
      if (source.includes('performance.timeOrigin + performance.now()')) return 1;
      return undefined;
    },
    on() {}, off() {},
  };
  try {
    const recorder = await createRecorder(page, {fixture:{project_id:'p', timeline_id:'t'},
      baseUrl:'http://localhost', resultsPath});
    const result = await recorder.runRow({name:'invalid', iteration:1, expected:'invalid'});
    assert.equal(result.pass, false);
    assert.match(result.error, /descriptor requires/);
    assert.deepEqual(result.save_marks, {marks_available:true, saves:[]});
    assert.deepEqual(JSON.parse(fs.readFileSync(resultsPath, 'utf8')).save_marks, result.save_marks);
    assert.equal(markReads, 2);
  } finally {
    fs.rmSync(dir, {recursive:true, force:true});
  }
});

test('row, cleanup, whole-sweep and close bounds race truly unresolved promises', async () => {
  assert.equal(rowBoundMs({}), 120_000);
  assert.equal(rowBoundMs({timeoutMs:1000}), 31_000);
  assert.equal(rowBoundMs({settle:4000}), 34_000);
  assert.equal(CLEANUP_BOUND_MS, 120_000);
  assert.equal(CLOSE_BOUND_MS, 10_000);
  assert.equal(sweepMaxMs('7200000'), 7_200_000);
  assert.equal(sweepMaxMs('500'), 500);
  for (const bad of ['0', '-1', 'bad', '2.5', '2147483648']) assert.throws(() => sweepMaxMs(bad));
  assert.equal(await withBound('row', 100, () => 42), 42);
  const original = new Error('page refused');
  await assert.rejects(withBound('row', 100, () => {throw original;}), e => e === original);
  for (const bound of ['row', 'cleanup', 'sweep', 'browser-close']) {
    await assert.rejects(withBound(bound, 10, never), error =>
      error instanceof SweepBoundError && error.bound === bound && error.limitMs === 10
      && Number.isFinite(error.elapsedMs));
  }
});

test('abort records status before bounded best-effort marks and closes the browser even if the mark read hangs', async () => {
  const capture = createRowMarkCapture(fakePage([], never), 10);
  await capture.start();
  const activeRow = {name:'heavy-move', iteration:1, capture};
  const records = [];
  let closed = false;
  const error = new SweepBoundError('row', 120_000, 120_005);
  await finishAbortedSweep(error, {activeRow, record: v => records.push(v), close:async () => {
    assert.equal(records.length, 2);
    closed = true;
  }});
  assert.equal(closed, true);
  assert.deepEqual(records[0], {type:'sweep_aborted', name:'heavy-move', iteration:1,
    bound:'row', limit_ms:120_000, elapsed_ms:120_005});
  assert.deepEqual(records[1].save_marks, unavailableSaveMarks());
  assert.equal(records[1].pass, false);
  assert.equal(capture.cancelled, true);
});

test('cleanup timeout identifies the row without duplicating its existing record; whole-sweep timeout may have no active row', async () => {
  const records = [];
  const capture = createRowMarkCapture(fakePage());
  capture.recorded = true;
  const activeRow = {name:'move', iteration:3, capture};
  const close = async () => {};
  await finishAbortedSweep(new SweepBoundError('cleanup', 120_000, 120_001),
    {activeRow, record:v => records.push(v), close});
  await finishAbortedSweep(new SweepBoundError('sweep', 500, 500),
    {record:v => records.push(v), close});
  assert.deepEqual(records.map(({name, iteration, bound}) => [name, iteration, bound]),
    [['move', 3, 'cleanup'], [null, null, 'sweep']]);
  assert.equal(records.every(v => v.type === 'sweep_aborted'), true);
});
