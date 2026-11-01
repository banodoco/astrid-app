import { describe, expect, it } from 'vitest';
import { ANIMATION_REGISTRY } from '@banodoco/timeline-composition/animations.generated';
import { EFFECT_REGISTRY } from '@banodoco/timeline-composition/effects.generated';
import { TRANSITION_REGISTRY } from '@banodoco/timeline-composition/transitions.generated';
import {
  PUBLIC_COMPOSITION_ELEMENT_COMPONENTS,
  resolvePublicCompositionElementComponent,
} from './publicCompositionElementRegistry';
describe('public Composition element registry bridge', () => {
  it('registers every installed public registry component by its host identity', () => {
    const expected = [
      ...Object.keys(EFFECT_REGISTRY).map((id) => `effect:${id}`),
      ...Object.keys(ANIMATION_REGISTRY).map((id) => `animation:${id}`),
      ...Object.keys(TRANSITION_REGISTRY).map((id) => `transition:${id}`),
    ].sort();
    expect(Object.keys(PUBLIC_COMPOSITION_ELEMENT_COMPONENTS).sort()).toEqual(expected);
    for (const id of Object.keys(EFFECT_REGISTRY)) {
      expect(resolvePublicCompositionElementComponent(id, 'effect')).toBe(EFFECT_REGISTRY[id]);
    }
    for (const id of Object.keys(ANIMATION_REGISTRY)) {
      expect(resolvePublicCompositionElementComponent(id, 'animation')).toBe(ANIMATION_REGISTRY[id]);
    }
    for (const id of Object.keys(TRANSITION_REGISTRY)) {
      expect(resolvePublicCompositionElementComponent(id, 'transition')).toBe(TRANSITION_REGISTRY[id]);
    }
  });
  it('does not claim local or unknown elements as public Composition components', () => {
    expect(resolvePublicCompositionElementComponent('end-spanning-layer', 'effect')).toBeUndefined();
    expect(resolvePublicCompositionElementComponent('audio-reactive-colour', 'effect')).toBeUndefined();
    expect(resolvePublicCompositionElementComponent('missing', 'effect')).toBeUndefined();
  });
});
