import { admittedComponent, getAdmittedElementSelection, isAdmittedElementPreviewPreparing, usesScopedElementAdmissions } from './admitted-elements';
import type { ComponentType } from 'react';
import { ASTRID_RENDERING_ELEMENTS } from '@astrid/packs/rendering/elements/catalog.ts';
import {
  LOCAL_SEQUENCE_REGISTRY,
  SEQUENCE_COMPONENT_REGISTRY,
  describeClipCapabilityWith,
  resolveSequenceClipEntry,
} from '@/tools/video-editor/sequences/registry.ts';
import { resolvePublicCompositionElementComponent } from './publicCompositionElementRegistry.ts';
import type {
  AstridDynamicSequenceEntry,
  AstridElementComponentProps,
  AstridElementHost,
} from '@/tools/video-editor/runtime/astrid-element-host.ts';

type AstridElementModule = {
  default?: ComponentType<AstridElementComponentProps>;
};

const asAstridElementComponent = (component: unknown): ComponentType<AstridElementComponentProps> => (
  component as ComponentType<AstridElementComponentProps>
);

/**
 * Some local Astrid effects have browser-only asset adapters. Astrid's worker
 * stages those pack assets and injects `__astridAssets`; the adapters provide
 * the equivalent Vite URLs for the live editor preview. Keep this mapping at
 * the canonical element resolver so both typed `elementRef` clips and legacy
 * clipType-only clips use the same component contract.
 */
const ASTRID_PREVIEW_COMPONENT_OVERRIDES: Record<
  string,
  ComponentType<AstridElementComponentProps>
> = {
  'end-spanning-layer': asAstridElementComponent(
    LOCAL_SEQUENCE_REGISTRY['end-spanning-layer'].component,
  ),
  'frame-overlay': asAstridElementComponent(
    LOCAL_SEQUENCE_REGISTRY['frame-overlay'].component,
  ),
};

// Astrid owns the element implementations. Vite resolves this glob through
// the configured @astrid source alias, so Astrid App previews the same checked-out
// Remotion component that Astrid's worker bundles. The catalog supplies the
// stable componentPath; this glob is only the host-side module bridge.
const ASTRID_ELEMENT_MODULES = import.meta.glob(
  [
    '@astrid/packs/*/elements/**/*.{ts,tsx}',
    '@astrid/packs/*/rendering/elements/**/*.{ts,tsx}',
    '!@astrid/packs/**/*.test.{ts,tsx}',
  ],
  { eager: true },
) as Record<string, AstridElementModule>;

export function resolveAstridElementComponent(
  elementId: string,
  kind: 'effect' | 'animation' | 'transition',
  packId?: string,
  revision?: string,
): ComponentType<AstridElementComponentProps> | undefined {
  if (packId && revision) {
    const admitted = admittedComponent({id: elementId, kind, packId, revision});
    if (admitted) return admitted;
  }
  const descriptor = ASTRID_RENDERING_ELEMENTS.find((element) => (
    element.id === elementId && element.kind === kind
    && (packId === undefined || element.packId === packId)
    && (revision === undefined || element.revision === revision)
  ));
  if (!descriptor?.componentPath) return undefined;

  if (
    kind === 'effect'
    && descriptor.packId === 'local'
    && Object.prototype.hasOwnProperty.call(ASTRID_PREVIEW_COMPONENT_OVERRIDES, elementId)
  ) {
    const previewOverride = ASTRID_PREVIEW_COMPONENT_OVERRIDES[elementId];
    if (previewOverride) return previewOverride;
  }

  // Composition owns the public rendering-pack components. They are intentionally
  // file-less in the installed host, so resolve them through the same package
  // registry used by the public host before consulting the Astrid source glob.
  if (descriptor.packId === 'rendering') {
    const compositionComponent = resolvePublicCompositionElementComponent(elementId, kind);
    if (compositionComponent) return compositionComponent;
  }

  const componentPath = descriptor.componentPath;
  const suffix = `/${componentPath}`;
  const modulePath = Object.keys(ASTRID_ELEMENT_MODULES).find((candidate) => (
    candidate.endsWith(suffix) || candidate.endsWith(componentPath)
  ));
  return modulePath ? ASTRID_ELEMENT_MODULES[modulePath]?.default : undefined;
}

/** Explicit installed host: preserves the current full catalog and sequence values. */
const installedAstridElementHost: AstridElementHost = {
  isPreviewPreparing(projectId, clips) {
    if (!usesScopedElementAdmissions()) return false;
    const refs = clips.flatMap(clip => clip.elementRef?.packId ? [clip.elementRef] : [])
      .filter(ref => !ASTRID_RENDERING_ELEMENTS.some(entry => entry.id === ref.id && entry.kind === ref.kind
        && entry.packId === ref.packId && entry.revision === ref.revision));
    // Scope is checked before component lookup so an old project's exact map
    // cannot briefly appear in a newly selected project's stage.
    return isAdmittedElementPreviewPreparing(projectId, refs);
  },
  get descriptors() { return [...ASTRID_RENDERING_ELEMENTS, ...getAdmittedElementSelection().elements.map(element => element.descriptor)]; },
  sequenceRegistry: SEQUENCE_COMPONENT_REGISTRY,
  resolveComponent: resolveAstridElementComponent,
  resolveSequenceClipEntry(clipType, dynamicEntries) {
    return resolveSequenceClipEntry(
      clipType,
      dynamicEntries as Parameters<typeof resolveSequenceClipEntry>[1],
    ) as AstridDynamicSequenceEntry | undefined;
  },
  describeClipCapability(clip, dynamicEntries) {
    return describeClipCapabilityWith(
      clip,
      dynamicEntries as Parameters<typeof describeClipCapabilityWith>[1],
    );
  },
};

export const INSTALLED_ASTRID_ELEMENT_HOST: AstridElementHost = Object.freeze(
  installedAstridElementHost,
);
