import { useEffect, useRef } from 'react';
import { registerDraftSafeReloadGuard } from '@/shared/lib/updates/draftSafeReload.ts';
import type { SaveStatus } from '@/tools/video-editor/hooks/useTimelinePersistence.ts';

interface UseEditorBrowserDefaultsOptions {
  /** The editor shell root: wheel zoom is blocked inside it, Cmd+S is claimed while focus is inside it. */
  shellRoot: HTMLElement | null;
  saveStatus: SaveStatus;
  flushPendingSave: () => Promise<unknown>;
  preserveTimelineDraftForReload: () => Promise<void>;
  isTimelineDraftDurableForReload: () => boolean;
  isTimelineSavePending?: () => boolean;
}

/**
 * Browser defaults the editor must not hand to Chrome: page zoom on Ctrl/Cmd+wheel (and trackpad pinch), "Save page
 * as" on Cmd/Ctrl+S, and closing or reloading with a timeline save still pending. Keyboard zoom (Cmd +/-/0) is left alone.
 */
export function useEditorBrowserDefaults({ shellRoot, saveStatus, flushPendingSave, preserveTimelineDraftForReload, isTimelineDraftDurableForReload, isTimelineSavePending }: UseEditorBrowserDefaultsOptions): void {
  const latest = useRef({ saveStatus, flushPendingSave, preserveTimelineDraftForReload, isTimelineDraftDurableForReload, isTimelineSavePending });
  latest.current = { saveStatus, flushPendingSave, preserveTimelineDraftForReload, isTimelineDraftDurableForReload, isTimelineSavePending };
  const currentSaveStatus = () => latest.current.saveStatus;
  const pending = () => latest.current.isTimelineSavePending?.() ?? currentSaveStatus() !== 'saved';

  useEffect(() => {
    // useTimelineSave owns authoritative registration, including unmounted work.
    if (!shellRoot || isTimelineSavePending) return;
    const flush = async () => {
      // Compatibility for shells without an authoritative persistence owner.
      for (let attempt = 0; attempt < 5; attempt++) {
        if (!pending()) return;
        await latest.current.flushPendingSave();
        await new Promise<void>((resolve) => window.setTimeout(resolve, 0));
        if (!pending()) return;
      }
      throw new Error('the timeline kept changing while it was being saved');
    };
    return registerDraftSafeReloadGuard({ label: 'Timeline', flush, isDirty: pending,
      flushForReload: async () => {
        try { await flush(); }
        catch { await latest.current.preserveTimelineDraftForReload(); }
      },
      isDirtyForReload: () => pending() && !latest.current.isTimelineDraftDurableForReload(),
    });
  }, [shellRoot, isTimelineSavePending]);

  useEffect(() => {
    if (!shellRoot) return;
    const onWheel = (event: WheelEvent) => {
      if (event.ctrlKey || event.metaKey) event.preventDefault();
    };
    shellRoot.addEventListener('wheel', onWheel, { passive: false });
    return () => shellRoot.removeEventListener('wheel', onWheel);
  }, [shellRoot]);

  useEffect(() => {
    if (!shellRoot) return;
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key.toLowerCase() !== 's' || !(event.metaKey || event.ctrlKey) || event.altKey || event.shiftKey) return;
      const target = event.target;
      if (!(target instanceof Node) || !shellRoot.contains(target)) return;
      event.preventDefault();
      if (latest.current.saveStatus === 'dirty') {
        void latest.current.flushPendingSave().catch(() => undefined);
      }
    };
    window.addEventListener('keydown', onKeyDown, { capture: true });
    return () => window.removeEventListener('keydown', onKeyDown, { capture: true });
  }, [shellRoot]);

  useEffect(() => {
    const onBeforeUnload = (event: BeforeUnloadEvent) => {
      if (!pending()) return;
      event.preventDefault();
      // Legacy browsers read returnValue to decide whether to prompt.
      event.returnValue = '';
    };
    window.addEventListener('beforeunload', onBeforeUnload);
    return () => window.removeEventListener('beforeunload', onBeforeUnload);
  }, []);
}
