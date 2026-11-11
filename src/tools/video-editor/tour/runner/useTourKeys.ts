import { useEffect } from 'react';
import { backEditorTour, finishEditorTour, runEditorTourPrimary } from './tourBeats';

/**
 * While the tour runs, one capture-phase listener owns the keyboard: Enter is the primary action,
 * ArrowLeft goes back, Esc skips the tour, and every other key is swallowed so timeline and chat shortcuts stay quiet.
 * Browser chords (Cmd/Ctrl) keep their default action, such as reload, but never reach the app.
 */
const OWN_KEYS = new Set(['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown', 'Home', 'End', 'PageUp', 'PageDown']);

export function useTourKeys(active: boolean): void {
  useEffect(() => {
    if (!active) return;
    function onKeyDown(event: KeyboardEvent) {
      // A control inside the card that steers with its own keys (the comparison slider) keeps them while it has focus.
      if (!event.metaKey && !event.ctrlKey && OWN_KEYS.has(event.key) && event.target instanceof Element && event.target.closest('[data-editor-tour-keys="own"]')) return;
      event.stopImmediatePropagation();
      if (event.metaKey || event.ctrlKey) return;
      event.preventDefault();
      if (event.repeat) return;
      if (event.key === 'Enter') runEditorTourPrimary();
      else if (event.key === 'ArrowLeft') backEditorTour();
      else if (event.key === 'Escape') finishEditorTour();
    }
    window.addEventListener('keydown', onKeyDown, { capture: true });
    return () => window.removeEventListener('keydown', onKeyDown, { capture: true });
  }, [active]);
}
