import { describe, expect, it } from 'vitest';
import { editorTourTargets, respondWorking, spotlightTargets } from './EditorTourRunner';
import { spotlightTargetKey } from './useSpotlightRects';

const LIVE = { chatReady: false, instant: false, reducedMotion: false };

describe('respond phases (desktop)', () => {
  it('is working only while the reply streams in, forward, with motion', () => {
    expect(respondWorking('desktop', 'respond', LIVE)).toBe(true);
    expect(respondWorking('desktop', 'respond', { ...LIVE, chatReady: true })).toBe(false);
    // Back and reduced motion arrive with the reply already there: straight to the actions.
    expect(respondWorking('desktop', 'respond', { ...LIVE, instant: true })).toBe(false);
    expect(respondWorking('desktop', 'respond', { ...LIVE, reducedMotion: true })).toBe(false);
    expect(respondWorking('desktop', 'land', LIVE)).toBe(false);
    expect(respondWorking('tablet', 'respond', LIVE)).toBe(false);
    expect(respondWorking('phone', 'respond', LIVE)).toBe(false);
  });

  it('holds one fixed rect, the whole transcript box, while working, then contracts onto the act’s actions', () => {
    expect(spotlightTargets(1, 'respond', 'desktop', true)).toEqual([{ selector: '[data-editor-tour="chat-transcript"]', whole: true }]);
    expect(spotlightTargets(1, 'respond', 'desktop', false)).toEqual(['[data-editor-tour="chat-actions"]']);
    // Two different target lists: the contraction is a new commit, never a drift of the first.
    expect(spotlightTargetKey(spotlightTargets(1, 'respond', 'desktop', true))).not.toBe(spotlightTargetKey(spotlightTargets(1, 'respond', 'desktop', false)));
  });

  it('leaves phones and tablets, and every other beat, to editorTourTargets', () => {
    for (const device of ['tablet', 'phone'] as const) expect(spotlightTargets(1, 'respond', device, false)).toEqual(editorTourTargets(1, 'respond', device));
    expect(spotlightTargets(2, 'land', 'desktop', false)).toEqual(editorTourTargets(2, 'land', 'desktop'));
  });
});
