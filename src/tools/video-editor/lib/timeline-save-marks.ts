/**
 * Bounded User Timing marks for the installed save-latency harness.
 *
 * Read with `performance.getEntriesByType('mark')` and filter names beginning
 * with `astrid.save.`. The numeric correlation joins phases without exposing
 * timeline IDs, payloads, or the internal trace ID. At most 16 saves (64 marks)
 * are retained; allocating the next correlation clears the oldest save's marks.
 */
export type TimelineSaveMarkPhase = 'gesture-end' | 'post-sent' | '200' | 'saved-badge';

const MARK_PREFIX = 'astrid.save.';
const MAX_RETAINED_SAVES = 16;

type SaveMarkRecord = {
  correlation: number;
  phases: Set<TimelineSaveMarkPhase>;
};

const records = new Map<string, SaveMarkRecord>();
let nextCorrelation = 1;

function recordFor(traceId: string): SaveMarkRecord {
  const existing = records.get(traceId);
  if (existing) return existing;

  if (records.size >= MAX_RETAINED_SAVES) {
    const oldestTraceId = records.keys().next().value;
    if (oldestTraceId !== undefined) {
      const oldest = records.get(oldestTraceId);
      if (oldest) {
        for (const phase of oldest.phases) {
          performance.clearMarks(`${MARK_PREFIX}${oldest.correlation}.${phase}`);
        }
      }
      records.delete(oldestTraceId);
    }
  }

  const record = { correlation: nextCorrelation++, phases: new Set<TimelineSaveMarkPhase>() };
  records.set(traceId, record);
  return record;
}

function mark(record: SaveMarkRecord, phase: TimelineSaveMarkPhase): void {
  if (record.phases.has(phase)) return;
  record.phases.add(phase);
  performance.mark(`${MARK_PREFIX}${record.correlation}.${phase}`, {
    detail: { correlation: record.correlation, phase },
  });
}

export function recordTimelineSaveMark(traceId: string, phase: TimelineSaveMarkPhase): void {
  mark(recordFor(traceId), phase);
}

/** Called after the save badge's Saved state has committed to the DOM. */
export function recordLatestTimelineSavedBadgeMark(): void {
  const latest = [...records.values()].at(-1);
  if (latest?.phases.has('200')) mark(latest, 'saved-badge');
}
