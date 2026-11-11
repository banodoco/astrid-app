import type { CSSProperties } from 'react';
import { useEditorTourRunning } from '@/shared/state/editorTourStore.ts';
import { UI_Z_LAYERS } from '@/shared/lib/uiLayers.ts';

/** Fixed update notices float above panes and the lightbox (`z-[100110]`), which is also above the tour's dimming shield. */
const NOTICE_Z_INDEX = 100110;

/**
 * Layer and inertness for a fixed page notice while the editor tour runs. The tour's dim and input shield sit at
 * `EDITOR_TOUR_SHIELD`, so a notice kept above it would stay lit and clickable over the dimmed page. During the tour it
 * drops under the shield (dimmed like everything else, no pointer input, no focus) and returns to its own layer after.
 */
export function useUnderEditorTour(): { style: CSSProperties; inert?: '' } {
  const touring = useEditorTourRunning();
  return touring
    ? { style: { zIndex: UI_Z_LAYERS.RUNTIME_RECOVERY_CARD }, inert: '' }
    : { style: { zIndex: NOTICE_Z_INDEX } };
}
