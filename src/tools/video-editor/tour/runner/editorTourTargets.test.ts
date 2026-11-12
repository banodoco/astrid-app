import { describe, expect, it } from 'vitest';
import { cardHidden, editorTourTargets, phoneLandPosition } from './EditorTourRunner';

describe('editorTourTargets', () => {
  it('spotlights the act’s new row with the preview on land', () => {
    expect(editorTourTargets(2, 'land')).toEqual(['[data-editor-tour-track="tour-stills"]', '[data-editor-tour="preview"]']);
    expect(editorTourTargets(1, 'compose')).toEqual(['[data-editor-tour="chat-composer"]']);
  });

  it('lights the whole Generations pane on gallery, on every device', () => {
    for (const device of ['desktop', 'tablet', 'phone'] as const) {
      expect(editorTourTargets(2, 'gallery', device)).toEqual(['[data-editor-tour="generations-pane"]']);
    }
  });

  it('lights only the act’s actions on respond, on every device', () => {
    for (const device of ['desktop', 'tablet', 'phone'] as const) {
      expect(editorTourTargets(1, 'respond', device)).toEqual(['[data-editor-tour="chat-actions"]']);
    }
  });

  it('lights nothing on the welcome, finale and feedback cards, which sit in the middle', () => {
    for (const beat of ['welcome', 'finale', 'feedback'] as const) expect(editorTourTargets(3, beat, 'phone')).toEqual([]);
  });
});

describe('phoneLandPosition', () => {
  it('hangs a phone’s land card from the top of the screen, whatever its height: folding its body never moves its top', () => {
    expect(phoneLandPosition()).toEqual({ left: 12, top: 6 });
  });
});

describe('cardHidden', () => {
  it('shows no card on touch while the reply comes in (desktop keeps its quiet card), nor on any device while a result plays alone', () => {
    expect(cardHidden('phone', 'working')).toBe(true);
    expect(cardHidden('tablet', 'working')).toBe(true);
    expect(cardHidden('desktop', 'working')).toBe(false);
    for (const device of ['desktop', 'tablet', 'phone'] as const) expect(cardHidden(device, 'watch')).toBe(true);
    expect(cardHidden('phone', undefined)).toBe(false);
  });
});
