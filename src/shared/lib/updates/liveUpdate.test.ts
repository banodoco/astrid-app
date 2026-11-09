// @vitest-environment jsdom
import { beforeEach, describe, expect, it } from 'vitest';
import { activeTransition, noteRelease, resetLiveUpdateForTest, UPDATED_NOTICE_MS, updatedLine } from './liveUpdate.ts';

beforeEach(() => resetLiveUpdateForTest());

describe('live update transition', () => {
  it('a new instance on a higher release is an update, and it survives the page reloading itself', () => {
    expect(noteRelease('a', 10, 1000)).toBeNull();
    const transition = noteRelease('b', 11, 2000);
    expect(transition).toEqual({ from: 10, to: 11, until: 2000 + UPDATED_NOTICE_MS });
    expect(updatedLine(transition!)).toBe('Astrid updated: Release 10 → Release 11');
    // After the reload the same tab still shows it, until it expires.
    expect(activeTransition(2001)).toEqual(transition);
    expect(activeTransition(2000 + UPDATED_NOTICE_MS)).toBeNull();
  });

  it('the same instance, the same release or a lower one is not an update', () => {
    noteRelease('a', 10);
    expect(noteRelease('a', 11)).toBeNull();
    expect(noteRelease('b', 11)).toBeNull();
    expect(noteRelease('c', 9)).toBeNull();
    expect(noteRelease(undefined, 12)).toBeNull();
  });
});
