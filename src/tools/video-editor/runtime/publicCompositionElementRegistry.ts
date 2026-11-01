import type { ComponentType } from 'react';
import {
  ANIMATION_REGISTRY,
} from '@banodoco/timeline-composition/animations.generated';
import { EFFECT_REGISTRY } from '@banodoco/timeline-composition/effects.generated';
import { TRANSITION_REGISTRY } from '@banodoco/timeline-composition/transitions.generated';
import type { AstridElementComponentProps } from './astrid-element-host.ts';
type PublicCompositionElementKind = 'effect' | 'animation' | 'transition';
const REGISTRY_SOURCES = [
  ['effect', EFFECT_REGISTRY],
  ['animation', ANIMATION_REGISTRY],
  ['transition', TRANSITION_REGISTRY],
] as const satisfies readonly [PublicCompositionElementKind, Readonly<Record<string, unknown>>][];
const asAstridElementComponent = (component: unknown): ComponentType<AstridElementComponentProps> => (
  component as ComponentType<AstridElementComponentProps>
);
/**
 * The public host consumes the same Composition registries as the evaluator.
 * Keep the map keyed by the host's existing kind/id identity so callers retain
 * descriptor, capability, and unknown-element handling at the host boundary.
 */
export const PUBLIC_COMPOSITION_ELEMENT_COMPONENTS = Object.freeze(
  Object.fromEntries(
    REGISTRY_SOURCES.flatMap(([kind, registry]) => (
      Object.entries(registry).map(([id, component]) => [
        `${kind}:${id}`,
        asAstridElementComponent(component),
      ])
    )),
  ),
) as Readonly<Record<string, ComponentType<AstridElementComponentProps>>>;
export function resolvePublicCompositionElementComponent(
  elementId: string,
  kind: PublicCompositionElementKind,
): ComponentType<AstridElementComponentProps> | undefined {
  return PUBLIC_COMPOSITION_ELEMENT_COMPONENTS[`${kind}:${elementId}`];
}
