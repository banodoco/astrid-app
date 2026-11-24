/**
 * Bounded User Timing marks for the installed save-latency harness.
 *
 * Read with `performance.getEntriesByType('mark')` and filter names beginning
 * with `astrid.save.`. The numeric correlation joins phases without exposing
 * timeline IDs, payloads, or the internal trace ID. At most 16 correlations with
 * a fixed phase vocabulary are retained; allocating the next correlation clears
 * the oldest one's marks. Extra phases record the first occurrence per trace:
 * use single warm saves for attribution, not multi-POST bursts or retries.
 */
export type TimelineSaveMarkPhase =
  | 'gesture-end' | 'post-sent' | '200' | 'saved-badge'
  | 'snapshot-start' | 'snapshot-ready'
  | 'draft-write-queued' | 'draft-write-start' | 'draft-write-ready'
  | 'capture-start' | 'capture-returned' | 'capture-settled'
  | 'debounce-armed' | 'debounce-fired'
  | 'attempt-build-start' | 'attempt-build-end'
  | 'capture-wait-start' | 'capture-wait-end'
  | 'handoff-flush-start' | 'local-flush-start'
  | 'outbox-read-start' | 'outbox-read-end'
  | 'request-build-start' | 'request-build-end' | 'request-reserved'
  | 'request-parse-start' | 'request-parse-end'
  | 'accepted-decode-start' | 'accepted-decode-end'
  | 'accepted-value-start' | 'accepted-value-end' | 'accepted-durable'
  | 'prepare-display-start' | 'prepare-display-end'
  | 'adopt-start' | 'adopt-end' | 'local-status-saved'
  | 'flush-basis-start' | 'flush-basis-end'
  | 'handoff-adopted-read-start' | 'handoff-adopted-read-end'
  | 'handoff-copy-start' | 'handoff-copy-end' | 'handoff-flush-end'
  | 'hook-ack-start' | 'hook-status-update';

const MARK_PREFIX = 'astrid.save.';
const MAX_RETAINED_SAVES = 16;

type SaveMarkRecord = {
  correlation: number;
  phases: Set<TimelineSaveMarkPhase>;
  milestoneOrder?: number;
};

const records = new Map<string, SaveMarkRecord>();
let nextCorrelation = 1;
let nextMilestoneOrder = 1;

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

export function recordTimelineSaveMark(traceId: string | null | undefined, phase: TimelineSaveMarkPhase): void {
  if (!traceId) return;
  try {
    const record = recordFor(traceId);
    // Early capture/recovery marks must not steal the existing badge
    // correlation from a save that has actually reached a baseline milestone.
    if (record.milestoneOrder === undefined
      && (phase === 'gesture-end' || phase === 'post-sent' || phase === '200' || phase === 'saved-badge')) {
      record.milestoneOrder = nextMilestoneOrder++;
    }
    mark(record, phase);
  } catch {
    // User Timing is diagnostic; an unavailable clock must never fail a save.
  }
}

/** Called after the save badge's Saved state has committed to the DOM. */
export function recordLatestTimelineSavedBadgeMark(): void {
  try {
    let latest: SaveMarkRecord | undefined;
    for (const record of records.values()) {
      if (record.milestoneOrder !== undefined
        && (!latest || record.milestoneOrder > latest.milestoneOrder!)) latest = record;
    }
    if (latest?.phases.has('200')) mark(latest, 'saved-badge');
  } catch {
    // Diagnostic only.
  }
}
