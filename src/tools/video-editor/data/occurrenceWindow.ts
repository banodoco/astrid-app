/**
 * The one rule for an occurrence's `source_offset`: the window origin into its shot's timeline.
 *
 * An occurrence shows the window [offset, offset + duration] of its shot's internal timeline,
 * starting at the occurrence's placement; a child at internal time tau therefore appears at
 * `start - offset + tau`. Every guard and projection asks this module; none keeps its own copy.
 * Mirrors the Agent's astrid/core/timeline/occurrence_window.py.
 *
 * Stored forms: a scalar in ms, or the mapping {start, end} in ms. Only `start` is read; `end` is a
 * legacy field that is never consulted. A valid offset is a finite number >= 0 and is never clamped.
 */
export class OccurrenceOffsetError extends RangeError {
  constructor(message: string) {
    super(message);
    this.name = 'OccurrenceOffsetError';
  }
}

/** The offset in ms (absent or null is 0). Throws OccurrenceOffsetError when it is not a valid window origin. */
export function readOccurrenceSourceOffsetMs(value: unknown): number {
  if (value === undefined || value === null) return 0;
  let scalar: unknown = value;
  if (typeof value === 'object' && !Array.isArray(value)) {
    const mapping = value as Record<string, unknown>;
    scalar = mapping.start ?? mapping.start_ms ?? 0;
  }
  if (typeof scalar !== 'number' || !Number.isFinite(scalar)) {
    throw new OccurrenceOffsetError('source_offset must be a finite number of milliseconds');
  }
  if (scalar < 0) throw new OccurrenceOffsetError('source_offset must not be negative');
  return scalar;
}

export function occurrenceOffsetIsValid(value: unknown): boolean {
  try {
    readOccurrenceSourceOffsetMs(value);
    return true;
  } catch {
    return false;
  }
}

/** The offset in seconds, for callers that work in seconds. Throws like readOccurrenceSourceOffsetMs. */
export function readOccurrenceSourceOffsetSeconds(value: unknown): number {
  return readOccurrenceSourceOffsetMs(value) / 1000;
}

const EPS = 1e-6;

/**
 * The one crop rule: a child span [start, end] cut to the window [offset, offset + length], all in one
 * unit (shot-local time). Null when none of it shows. Mirrors the Agent's `visible_span_ms`.
 */
export function visibleSpan(start: number, end: number, offset: number, length: number): [number, number] | null {
  const low = Math.max(start, offset);
  const high = Math.min(end, offset + length);
  return high > low + EPS ? [low, high] : null;
}
