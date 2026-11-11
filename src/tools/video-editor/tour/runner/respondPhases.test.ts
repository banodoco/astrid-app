import { describe, expect, it } from 'vitest';
import { editorTourTargets, respondWorking, spotlightTargets } from './EditorTourRunner';
import { spotlightTargetKey } from './useSpotlightRects';

const LIVE = { chatReady: false, instant: false, reducedMotion: false };

describe('respond phases', () => {
  it('is working only while the reply streams in, forward, with motion', () => {
    expect(respondWorking('respond', LIVE)).toBe(true);
    expect(respondWorking('respond', { ...LIVE, chatReady: true })).toBe(false);
    // Back and reduced motion arrive with the reply already there: straight to the actions.
    expect(respondWorking('respond', { ...LIVE, instant: true })).toBe(false);
    expect(respondWorking('respond', { ...LIVE, reducedMotion: true })).toBe(false);
    expect(respondWorking('land', LIVE)).toBe(false);
  });

  it.each(['desktop', 'tablet', 'phone'] as const)('on %s holds one fixed rect, the whole transcript box, while working, then lights only the act’s actions', (device) => {
    expect(spotlightTargets(1, 'respond', device, true)).toEqual([{ selector: '[data-editor-tour="chat-transcript"]', whole: true }]);
    expect(spotlightTargets(1, 'respond', device, false)).toEqual(['[data-editor-tour="chat-actions"]']);
    // Two different target lists: the contraction is a new commit, never a drift of the first.
    expect(spotlightTargetKey(spotlightTargets(1, 'respond', device, true))).not.toBe(spotlightTargetKey(spotlightTargets(1, 'respond', device, false)));
  });

  it('leaves every other beat to editorTourTargets', () => {
    expect(spotlightTargets(2, 'land', 'desktop', false)).toEqual(editorTourTargets(2, 'land', 'desktop'));
  });
});
