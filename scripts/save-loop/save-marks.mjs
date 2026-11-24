// Save-loop timing evidence and bounded waits. No Playwright dependency:
// both the row capture and the watchdog can be exercised with fake pages.
const MARK_NAME = /^astrid\.save\.([1-9]\d*)\.(gesture-end|post-sent|200|saved-badge)$/;
const PHASES = {'gesture-end':'gesture_end', 'post-sent':'post_sent', '200':'ok_200', 'saved-badge':'saved_badge'};
export const DEFAULT_ROW_TIMEOUT_MS = 90_000;
export const MARK_READ_MS = 5_000;
export const CLEANUP_BOUND_MS = 120_000;
export const CLOSE_BOUND_MS = 10_000;
const DEFAULT_SWEEP_MAX_MS = 2 * 60 * 60 * 1000;
const MAX_TIMER_MS = 2_147_483_647;

export class SweepBoundError extends Error {
  constructor(bound, limitMs, elapsedMs) {
    super(`${bound} bound exceeded (${limitMs} ms)`);
    this.name = 'SweepBoundError';
    this.bound = bound;
    this.limitMs = limitMs;
    this.elapsedMs = elapsedMs;
  }
}

export async function withBound(bound, limitMs, operation) {
  if (!Number.isFinite(limitMs) || limitMs <= 0 || limitMs > MAX_TIMER_MS)
    throw new RangeError(`invalid ${bound} bound: ${limitMs}`);
  const started = performance.now();
  let timer;
  try {
    return await Promise.race([
      new Promise((_, reject) => {
        timer = setTimeout(() => reject(new SweepBoundError(bound, limitMs, Math.round(performance.now() - started))), limitMs);
      }),
      Promise.resolve().then(operation),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

export function rowBoundMs(descriptor) {
  const limits = [descriptor.timeoutMs, descriptor.settle].filter(Number.isFinite);
  return (limits.length ? Math.max(...limits) : DEFAULT_ROW_TIMEOUT_MS) + 30_000;
}

export function sweepMaxMs(value = process.env.SAVE_LOOP_SWEEP_MAX_MS) {
  const ms = value === undefined ? DEFAULT_SWEEP_MAX_MS : Number(value);
  if (!Number.isSafeInteger(ms) || ms <= 0 || ms > MAX_TIMER_MS)
    throw new RangeError('SAVE_LOOP_SWEEP_MAX_MS must be a positive integer within the Node timer range');
  return ms;
}

function groupMarks(entries) {
  const grouped = new Map();
  for (const entry of entries) {
    const match = MARK_NAME.exec(entry?.name);
    if (!match || !Number.isFinite(entry.startTime)) continue;
    const n = Number(match[1]);
    if (!Number.isSafeInteger(n)) continue;
    const phases = grouped.get(n) ?? {};
    const phase = PHASES[match[2]];
    // The producer emits each phase once; keep the earliest if duplicated.
    phases[phase] = Math.min(phases[phase] ?? Infinity, entry.startTime);
    grouped.set(n, phases);
  }
  return grouped;
}

export function highestSaveCounter(entries) {
  return Math.max(0, ...groupMarks(entries).keys());
}

export function unavailableSaveMarks() {
  return {marks_available:false, saves:[]};
}

export function relativeSaveMarks(entries, beforeCounter) {
  if (beforeCounter === null || beforeCounter === undefined) return unavailableSaveMarks();
  const grouped = groupMarks(entries);
  const saves = [...grouped].sort(([a], [b]) => a - b).filter(([n]) => n > beforeCounter)
    .map(([n, phases]) => {
      const origin = phases.gesture_end;
      const relative = phase => Number.isFinite(origin) && Number.isFinite(phases[phase])
        ? Math.round((phases[phase] - origin) * 10) / 10 : null;
      return {n, gesture_end:relative('gesture_end'), post_sent:relative('post_sent'),
        ok_200:relative('ok_200'), saved_badge:relative('saved_badge')};
    });
  return {marks_available:grouped.size > 0, saves};
}

export function readPageMarks(page) {
  return page.evaluate(() => performance.getEntriesByType('mark')
    .filter(entry => entry.name.startsWith('astrid.save.'))
    .map(({name, startTime}) => ({name, startTime})));
}

// A new capture per row. Before the gesture, watermark the page counter;
// after settlement (or a thrown row), take exactly one best-effort snapshot.
// The same promise is shared by the normal recorder and the timeout fallback.
export function createRowMarkCapture(page, readMs = MARK_READ_MS) {
  let baseline = null;
  let snapshot;
  const capture = {
    cancelled:false,
    recorded:false,
    async start() {
      try {
        baseline = highestSaveCounter(await withBound('save-mark-baseline', readMs, () => readPageMarks(page)));
      } catch {
        // No known baseline: do not attribute old saves to this row.
        baseline = null;
      }
    },
    read() {
      const before = baseline;
      return snapshot ??= withBound('save-mark-read', readMs, () => readPageMarks(page))
        .then(entries => relativeSaveMarks(entries, before))
        .catch(() => unavailableSaveMarks());
    },
  };
  return capture;
}

// The caller sets activeRow before starting runRow. A row-bound or whole-sweep
// timeout can race the recorder: cancel its publication and append only one
// failure row, using the same in-flight mark snapshot if there is one.
export async function recordThrownRow(activeRow, error, record) {
  const {capture, name, iteration} = activeRow;
  if (capture.recorded) return null;
  capture.cancelled = true;
  return activeRow.failurePromise ??= (async () => {
    const row = {name, iteration, pass:false, error:String(error?.message || error),
      save_marks:await capture.read()};
    record({type:'row', ...row});
    capture.recorded = true;
    return row;
  })();
}

export function sweepAbortedRecord(error, activeRow) {
  return {type:'sweep_aborted', name:activeRow?.name ?? null,
    iteration:activeRow?.iteration ?? null, bound:error.bound,
    limit_ms:error.limitMs, elapsed_ms:error.elapsedMs};
}

export async function finishAbortedSweep(error, {activeRow, record, close}) {
  // Status precedes any further page call so a stalled mark read cannot
  // conceal the bound that was hit. The caller supplies a bounded close.
  try {
    record(sweepAbortedRecord(error, activeRow));
    if (activeRow) await recordThrownRow(activeRow, error, record);
  } finally {
    await close();
  }
}
