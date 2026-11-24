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

  it('keeps early attribution private, first-occurrence only, and out of badge selection until a milestone', () => {
    recordTimelineSaveMark(undefined, 'capture-start');
    recordTimelineSaveMark('measured-save-private', 'snapshot-start');
    recordTimelineSaveMark('measured-save-private', 'snapshot-start');
    recordTimelineSaveMark('measured-save-private', 'gesture-end');
    recordTimelineSaveMark('measured-save-private', 'post-sent');
    recordTimelineSaveMark('measured-save-private', '200');
    recordTimelineSaveMark('unrelated-capture-private', 'capture-start');
    recordLatestTimelineSavedBadgeMark();

    const marks = performance.getEntriesByType('mark').filter((entry) => entry.name.startsWith(PREFIX));
    const measured = marks.find((entry) => entry.name.endsWith('.snapshot-start'))!;
    const correlation = measured.name.split('.')[2];
    expect(marks.filter((entry) => entry.name.startsWith(`${PREFIX}${correlation}.`))
      .map((entry) => entry.name.split('.').at(-1))).toEqual([
      'snapshot-start', 'gesture-end', 'post-sent', '200', 'saved-badge',
    ]);
    expect(marks.filter((entry) => entry.name.endsWith('.capture-start'))).toHaveLength(1);
    expect(marks.every((entry) => /^astrid\.save\.\d+\.[a-z0-9-]+$/.test(entry.name))).toBe(true);
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
