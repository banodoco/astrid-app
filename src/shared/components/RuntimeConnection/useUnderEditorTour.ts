import type { CSSProperties } from 'react';
import { useEditorTourRunning } from '@/shared/state/editorTourStore.ts';
import { UI_Z_LAYERS } from '@/shared/lib/uiLayers.ts';

/**
 * Layer and inertness for a fixed page notice while the editor tour runs. These notices carry `z-[100110]`, which is
 * above the tour's dimming and input shield (`EDITOR_TOUR_SHIELD`), so without this they stay lit and clickable over the
 * dimmed page. During the tour the notice drops under the shield (dimmed like everything else, no pointer input, no
 * focus); the inline z-index overrides the class only then, and it returns to its own layer after.
 */
export function useUnderEditorTour(): { style?: CSSProperties; inert?: '' } {
  const touring = useEditorTourRunning();
  return touring ? { style: { zIndex: UI_Z_LAYERS.RUNTIME_RECOVERY_CARD }, inert: '' } : {};
}
