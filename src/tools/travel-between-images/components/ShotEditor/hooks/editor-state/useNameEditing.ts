/**
 * useNameEditing - Manages shot name editing state and handlers
 *
 * Handles the inline name editing UI state and keyboard/mouse interactions.
 */

import { useCallback, useEffect, useRef } from 'react';
import type { ShotEditorActions } from '../../state/useShotEditorState';
import { Shot } from '@/domains/generation/types';

interface UseNameEditingProps {
  selectedShot: Shot | undefined;
  state: {
    isEditingName: boolean;
    editingName: string;
  };
  actions: ShotEditorActions;
  onUpdateShotName?: (name: string) => void | Promise<void>;
  onBeforeNameEdit?: () => void;
}

interface UseNameEditingReturn {
  handleNameClick: () => void;
  handleNameSave: () => void;
  handleNameCancel: (e?: React.MouseEvent) => void;
  handleNameKeyDown: (e: React.KeyboardEvent) => void;
}

export function useNameEditing({
  selectedShot,
  state,
  actions,
  onUpdateShotName,
  onBeforeNameEdit,
}: UseNameEditingProps): UseNameEditingReturn {
  const syncedShotIdRef = useRef<string | null>(selectedShot?.id ?? null);
  const pendingSaveRef = useRef<Promise<void> | null>(null);
  const mountedRef = useRef(true);

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
      pendingSaveRef.current = null;
    };
  }, []);

  // Sync editor name from shot data.
  // Hard reset only when switching to a different shot; otherwise do not
  // interrupt an active inline edit for the same shot.
  useEffect(() => {
    const nextShotId = selectedShot?.id ?? null;
    const nextShotName = selectedShot?.name || '';

    if (syncedShotIdRef.current !== nextShotId) {
      syncedShotIdRef.current = nextShotId;
      pendingSaveRef.current = null;
      actions.setEditingNameValue(nextShotName);
      actions.setEditingName(false);
      return;
    }

    if (!state.isEditingName) {
      actions.setEditingNameValue(nextShotName);
    }
  }, [selectedShot?.id, selectedShot?.name, state.isEditingName, actions]);

  const handleNameClick = useCallback(() => {
    if (onUpdateShotName) {
      onBeforeNameEdit?.();
      actions.setEditingNameValue(selectedShot?.name || '');
      actions.setEditingName(true);
    }
  }, [onBeforeNameEdit, onUpdateShotName, selectedShot?.name, actions]);

  const handleNameSave = useCallback(() => {
    const draft = state.editingName;
    const name = draft.trim();
    if (!onUpdateShotName || !name || name === selectedShot?.name) {
      actions.setEditingName(false);
      return;
    }
    if (pendingSaveRef.current) return pendingSaveRef.current;
    const shotId = selectedShot?.id;
    try {
      const result = onUpdateShotName(name);
      if (!result || typeof result.then !== 'function') {
        actions.setEditingName(false);
        return;
      }
      const pending = Promise.resolve(result).then(
        () => {
          if (!mountedRef.current || pendingSaveRef.current !== pending || syncedShotIdRef.current !== shotId) return;
          pendingSaveRef.current = null;
          actions.setEditingName(false);
        },
        () => {
          if (!mountedRef.current || pendingSaveRef.current !== pending || syncedShotIdRef.current !== shotId) return;
          pendingSaveRef.current = null;
          // The submitted value is trimmed, but the form must restore exactly
          // what the user typed when the accepted completion refuses.
          actions.setEditingNameValue(draft);
          actions.setEditingName(true);
        },
      );
      pendingSaveRef.current = pending;
      return pending;
    } catch {
      actions.setEditingNameValue(draft);
      actions.setEditingName(true);
    }
  }, [onUpdateShotName, state.editingName, selectedShot?.id, selectedShot?.name, actions]);

  const handleNameCancel = useCallback((e?: React.MouseEvent) => {
    if (pendingSaveRef.current) return;
    // Prevent event propagation to avoid clicking elements that appear after layout change
    if (e) {
      e.preventDefault();
      e.stopPropagation();
    }

    actions.setEditingNameValue(selectedShot?.name || '');

    // Set transition flag to temporarily disable navigation buttons
    actions.setTransitioningFromNameEdit(true);

    // Add a small delay before hiding the editing mode to prevent click-through
    // to elements that appear in the same position
    setTimeout(() => {
      actions.setEditingName(false);
      // Clear transition flag after a slightly longer delay to ensure UI has settled
      setTimeout(() => {
        actions.setTransitioningFromNameEdit(false);
      }, 200);
    }, 100);
  }, [selectedShot?.name, actions]);

  const handleNameKeyDown = useCallback((e: React.KeyboardEvent) => {
    if (e.key === 'Enter') {
      handleNameSave();
    } else if (e.key === 'Escape') {
      handleNameCancel();
    }
  }, [handleNameSave, handleNameCancel]);

  return {
    handleNameClick,
    handleNameSave,
    handleNameCancel,
    handleNameKeyDown,
  };
}
