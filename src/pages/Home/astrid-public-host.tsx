import type { ComponentType } from 'react';
import { ASTRID_RENDERING_ELEMENTS } from '@astrid-public/packs/rendering/elements/public-catalog.ts';
import AudioReactiveColour from '@astrid-public/packs/rendering/rendering/elements/effects/audio-reactive-colour/component.tsx';
import EndSpanningLayer from '@astrid-public/packs/local/rendering/elements/effects/end-spanning-layer/component.tsx';
import FrameOverlay from '@astrid-public/packs/local/rendering/elements/effects/frame-overlay/component.tsx';
import card0 from '@astrid-public/packs/local/rendering/elements/effects/end-spanning-layer/assets/card-0.png?url';
import card1 from '@astrid-public/packs/local/rendering/elements/effects/end-spanning-layer/assets/card-1.png?url';
import card2 from '@astrid-public/packs/local/rendering/elements/effects/end-spanning-layer/assets/card-2.png?url';
import card3 from '@astrid-public/packs/local/rendering/elements/effects/end-spanning-layer/assets/card-3.png?url';
import card4 from '@astrid-public/packs/local/rendering/elements/effects/end-spanning-layer/assets/card-4.png?url';
import card5 from '@astrid-public/packs/local/rendering/elements/effects/end-spanning-layer/assets/card-5.png?url';
import frame from '@astrid-public/packs/local/rendering/elements/effects/frame-overlay/assets/frame.png?url';
import { createAstridPreviewAssetWrapper } from '@/tools/video-editor/sequences/components/createAstridPreviewAssetWrapper.tsx';
import { PUBLIC_COMPOSITION_ELEMENT_COMPONENTS } from '@/tools/video-editor/runtime/publicCompositionElementRegistry.ts';
import type {
  AstridDynamicSequenceEntry,
  AstridElementComponentProps,
  AstridElementDescriptor,
  AstridElementHost,
} from '@/tools/video-editor/runtime/astrid-element-host.ts';

const EndSpanningLayerPreview = createAstridPreviewAssetWrapper(
  EndSpanningLayer,
  {card0, card1, card2, card3, card4, card5},
);
const FrameOverlayPreview = createAstridPreviewAssetWrapper(FrameOverlay, {frame});

const asComponent = (value: unknown) => value as ComponentType<AstridElementComponentProps>;
const compositionComponentEntries = Object.entries(PUBLIC_COMPOSITION_ELEMENT_COMPONENTS) as Array<[
  string,
  ComponentType<AstridElementComponentProps>,
]>;
const componentEntries: Array<[string, ComponentType<AstridElementComponentProps>]> = [
  ...compositionComponentEntries,
  ['effect:audio-reactive-colour', asComponent(AudioReactiveColour)],
  ['effect:end-spanning-layer', asComponent(EndSpanningLayerPreview)],
  ['effect:frame-overlay', asComponent(FrameOverlayPreview)],
];
const components = new Map(componentEntries);

if (ASTRID_RENDERING_ELEMENTS.length !== 12 || components.size !== 12) {
  throw new Error('Astrid public host requires exactly twelve descriptors and components');
}
const publicComponentKeys = new Set<string>();
for (const descriptor of ASTRID_RENDERING_ELEMENTS) {
  const componentKey = `${descriptor.kind}:${descriptor.id}`;
  if (publicComponentKeys.has(componentKey)) {
    throw new Error(`Astrid public host has duplicate ${componentKey}`);
  }
  publicComponentKeys.add(componentKey);
  if (!components.has(componentKey)) {
    throw new Error(`Astrid public host is missing ${componentKey}`);
  }
}
if (publicComponentKeys.size !== components.size) {
  throw new Error('Astrid public host has an unregistered component');
}

const sequenceRegistry = Object.freeze({
  'end-spanning-layer': {component: EndSpanningLayerPreview, themeId: '2rp', source: 'public:astrid'},
  'frame-overlay': {component: FrameOverlayPreview, themeId: '2rp', source: 'public:astrid'},
});

function resolvePublicSequenceEntry(
  clipType: string | undefined,
  dynamicEntries: readonly AstridDynamicSequenceEntry[],
): AstridDynamicSequenceEntry | undefined {
  if (!clipType) return undefined;
  const normalized = clipType.startsWith('custom:') ? clipType.slice('custom:'.length) : clipType;
  const dynamic = dynamicEntries.find((entry) => entry.clipType === normalized);
  if (dynamic && (clipType.startsWith('custom:') || !(normalized in sequenceRegistry))) return dynamic;
  return undefined;
}

const publicAstridElementHost: AstridElementHost = {
  descriptors: ASTRID_RENDERING_ELEMENTS,
  sequenceRegistry,
  resolveComponent(elementId, kind, packId) {
    const descriptor = (ASTRID_RENDERING_ELEMENTS as readonly AstridElementDescriptor[]).find((item) => (
      item.id === elementId
      && item.kind === kind
      && (packId === undefined || item.packId === packId)
    ));
    if (!descriptor) return undefined;
    return components.get(`${descriptor.kind}:${descriptor.id}`);
  },
  resolveSequenceClipEntry: resolvePublicSequenceEntry,
  describeClipCapability(clip, dynamicEntries) {
    const dynamic = resolvePublicSequenceEntry(clip?.clipType, dynamicEntries);
    if (dynamic) {
      return {
        clipType: dynamic.clipType,
        source: 'db-sequence-component',
        capabilities: {preview: 'browser', browserRender: true, workerRender: false, externalRender: false},
      };
    }
    const clipType = clip?.clipType;
    if (!clipType || !(clipType in sequenceRegistry)) return undefined;
    return {
      clipType,
      source: 'trusted-local-sequence',
      capabilities: {preview: 'browser', browserRender: false, workerRender: true, externalRender: false},
    };
  },
};
export const PUBLIC_ASTRID_ELEMENT_HOST = Object.freeze(publicAstridElementHost);

export const PUBLIC_ASTRID_ASSET_URLS = Object.freeze({
  card0, card1, card2, card3, card4, card5, frame,
});
