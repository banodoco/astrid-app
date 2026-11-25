import { afterEach, describe, expect, it } from 'vitest';
import { recordLatestTimelineSavedBadgeMark, recordTimelineSaveMark } from './timeline-save-marks.ts';

const PREFIX = 'astrid.save.';

afterEach(() => {
  for (const entry of performance.getEntriesByType('mark')) {
    if (entry.name.startsWith(PREFIX)) performance.clearMarks(entry.name);
  }
});

describe('timeline save timing marks', () => {
  it('correlates the four milestones without exposing the internal trace ID', () => {
    const privateTraceId = 'private-timeline-identifier';
    recordTimelineSaveMark(privateTraceId, 'gesture-end');
    recordTimelineSaveMark(privateTraceId, 'post-sent');
    recordTimelineSaveMark(privateTraceId, '200');
    recordLatestTimelineSavedBadgeMark();

    const marks = performance.getEntriesByType('mark').filter((entry) => entry.name.startsWith(PREFIX));
    expect(marks.map(({ name }) => name.split('.').at(-1))).toEqual([
      'gesture-end', 'post-sent', '200', 'saved-badge',
    ]);
    const correlations = new Set(marks.map(({ name }) => name.match(/^astrid\.save\.(\d+)\./)?.[1]));
    expect(correlations.size).toBe(1);
    expect([...correlations][0]).toMatch(/^\d+$/);
    expect(marks.every(({ name }) => !name.includes(privateTraceId))).toBe(true);
  });

  it('retains at most sixteen save correlations', () => {
    let firstCorrelation = '';
    for (let index = 0; index < 17; index += 1) {
      recordTimelineSaveMark(`bounded-save-${index}`, 'post-sent');
      if (index === 0) {
        const firstMark = performance.getEntriesByType('mark').find((entry) => entry.name.startsWith(PREFIX));
        firstCorrelation = firstMark?.name.match(/^astrid\.save\.(\d+)\./)?.[1] ?? '';
      }
    }

    const marks = performance.getEntriesByType('mark').filter((entry) => entry.name.startsWith(PREFIX));
    expect(marks).toHaveLength(16);
    expect(firstCorrelation).not.toBe('');
    expect(marks.some(({ name }) => name.startsWith(`${PREFIX}${firstCorrelation}.`))).toBe(false);
  });
});
