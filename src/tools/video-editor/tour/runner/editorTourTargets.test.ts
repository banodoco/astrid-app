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
  const track = { x: 0, y: 440, width: 393, height: 44 };
  const preview = { x: 6, y: 150, width: 381, height: 216 };

  it('puts a phone’s land card above the preview, so the preview and the rows under it stay in view', () => {
    expect(phoneLandPosition([track, preview], { height: 120 })).toEqual({ left: 12, top: 150 - 8 - 120 });
  });

  it('starts at the top edge when the card is taller than the space there, never lower', () => {
    expect(phoneLandPosition([track, preview], { height: 160 })).toEqual({ left: 12, top: 12 });
  });
});

describe('cardHidden', () => {
  it('shows no card on touch while the reply comes in; desktop keeps its quiet card, and a watch its bar', () => {
    expect(cardHidden('phone', 'working')).toBe(true);
    expect(cardHidden('tablet', 'working')).toBe(true);
    expect(cardHidden('desktop', 'working')).toBe(false);
    expect(cardHidden('phone', 'watch')).toBe(false);
    expect(cardHidden('phone', undefined)).toBe(false);
  });
});
