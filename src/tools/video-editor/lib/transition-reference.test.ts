import { describe, expect, it } from 'vitest';
import { transitionReferenceFrames, transitionReferenceId } from './transition-reference';

describe('preview transition references', () => {
  it.each([
    [{ id: 'cross-fade', durationFrames: 15 }, 'cross-fade', 15],
    [{ type: 'fade', duration: 0.5 }, 'fade', 15],
    [{ id: 'fade' }, 'fade', 8],
    [{ type: 'cross-fade' }, 'cross-fade', 8],
  ])('resolves agent and legacy transition forms %j', (reference, id, durationFrames) => {
    expect(transitionReferenceId(reference)).toBe(id);
    expect(transitionReferenceFrames(reference, 30)).toBe(durationFrames);
  });

  it('uses the incoming clip transition as the preview transition owner', () => {
    const outgoing = { id: 'outgoing', transition: undefined };
    const incoming = { id: 'incoming', transition: { id: 'fade', durationFrames: 8 } };

    expect(transitionReferenceId(incoming.transition)).toBe('fade');
    expect(transitionReferenceId(outgoing.transition)).toBeUndefined();
  });
});
