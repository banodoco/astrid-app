import { useCallback, useEffect, useMemo, useState } from 'react';
import { useUserUIState } from '@/shared/hooks/useUserUIState';
import { useIsMobile, useIsTablet } from '@/shared/hooks/mobile';
import { usePaneControlsHosted } from '@/shared/state/paneControlsHost';
import { usePaneLockHolds } from '@/shared/state/paneLockHolds';
import { usePersistentState } from '@/shared/hooks/usePersistentState';

type PaneLockKey = 'shots' | 'tasks' | 'gens' | 'editor';

interface PaneLocksState {
  shots: boolean;
  tasks: boolean;
  gens: boolean;
  editor: boolean;
}

const UNLOCKED_PANES: PaneLocksState = {
  shots: false,
  tasks: false,
  gens: false,
  editor: false,
};

/** The Tasks (Activity) pane lock the user last chose on this browser. `null` means nothing saved yet. */
export const TASKS_PANE_LOCK_STORAGE_KEY = 'astrid.tasks-pane-locked.v1';

export function usePaneLockPolicyState() {
  const isMobile = useIsMobile();
  const isTablet = useIsTablet();
  // Phones, and pages that host the pane entry points themselves (paneControlsHost.ts),
  // never lock panes. A lock saved elsewhere is kept, not applied, and returns on leaving.
  const paneControlsHosted = usePaneControlsHosted();
  const transientPanes = (isMobile && !isTablet) || paneControlsHosted;

  // A first visit on desktop opens the Tasks pane locked. Phones and tablets keep the pane unlocked by default.
  const isDesktop = !isMobile && !isTablet;
  const [savedTasksLock, saveTasksLock] = usePersistentState<boolean | null>(TASKS_PANE_LOCK_STORAGE_KEY, null);
  const { value: paneLocks, update: savePaneLocks, isLoading } = useUserUIState(
    'paneLocks',
    { ...UNLOCKED_PANES, tasks: savedTasksLock ?? isDesktop },
  );
  const [userLocks, setLocks] = useState(paneLocks);
  const holds = usePaneLockHolds();

  const [isGenerationsPaneOpenState, setIsGenerationsPaneOpenState] = useState(false);
  const [isEditorPaneOpenState, setIsEditorPaneOpenState] = useState(false);
  const [userTasksOpen, setIsTasksPaneOpenState] = useState(false);

  // The saved lock can arrive after first paint (a new browser reads it from the Runtime): apply it when it differs.
  useEffect(() => {
    if (transientPanes || savedTasksLock === null) return;
    setLocks((previous) => (previous.tasks === savedTasksLock ? previous : { ...previous, tasks: savedTasksLock }));
    setIsTasksPaneOpenState(savedTasksLock);
  }, [savedTasksLock, transientPanes]);

  useEffect(() => {
    if (transientPanes) {
      setLocks(UNLOCKED_PANES);
      // A Tasks pane held open by a saved lock closes with it.
      setIsTasksPaneOpenState(false);
      return;
    }

    if (!isLoading) {
      let newLocks = paneLocks;
      if (isTablet) {
        const activeLocks = Object.entries(paneLocks).filter(([_, locked]) => locked);
        if (activeLocks.length > 1) {
          const firstLocked = activeLocks[0][0] as PaneLockKey;
          newLocks = {
            shots: firstLocked === 'shots',
            tasks: firstLocked === 'tasks',
            gens: firstLocked === 'gens',
            editor: firstLocked === 'editor',
          };
        }
      }
      setLocks(newLocks);
      setIsTasksPaneOpenState(newLocks.tasks);
    }
  }, [isLoading, paneLocks, transientPanes, isTablet]);

  const createPaneLockSetter = useCallback(
    (lockKey: PaneLockKey) => (isLocked: boolean) => {
      // Transient-pane hosts (phones, paneControlsHosted pages) never lock: the lock policy above says so.
      if (typeof isLocked !== 'boolean' || transientPanes) {
        return;
      }
      setLocks((prev) => {
        if (prev[lockKey] === isLocked) return prev;
        const exclusiveLock = (isMobile || isTablet) && isLocked;
        return exclusiveLock
          ? { ...UNLOCKED_PANES, [lockKey]: isLocked }
          : { ...prev, [lockKey]: isLocked };
      });

      if (!transientPanes) {
        const exclusiveLock = (isMobile || isTablet) && isLocked;
        savePaneLocks(
          exclusiveLock
            ? { ...UNLOCKED_PANES, [lockKey]: isLocked }
            : { [lockKey]: isLocked },
        );
        // Remember the Tasks lock as the user leaves it, including when an exclusive lock clears it.
        const tasksChoice = lockKey === 'tasks' ? isLocked : exclusiveLock ? false : null;
        if (tasksChoice !== null) saveTasksLock(tasksChoice);
      }

      if (lockKey === 'tasks') {
        setIsTasksPaneOpenState(isLocked);
      } else if ((isMobile || isTablet) && isLocked) {
        setIsTasksPaneOpenState(false);
      }
    },
    [isMobile, isTablet, transientPanes, savePaneLocks, saveTasksLock],
  );

  // What the app sees: the user's saved locks with any holds (paneLockHolds.ts) laid over them. Nothing here is saved.
  const locks = useMemo((): PaneLocksState => {
    if (transientPanes) return userLocks;
    const held = { ...userLocks, ...holds };
    // A tablet shows one locked pane: a held lock replaces the rest, as locking it would have.
    return isTablet && Object.values(holds).some(Boolean) ? { ...UNLOCKED_PANES, ...holds } : held;
  }, [userLocks, holds, transientPanes, isTablet]);
  const isTasksPaneOpenState = !transientPanes && holds.tasks !== undefined ? holds.tasks : userTasksOpen;

  const setIsGenerationsPaneLocked = useMemo(() => createPaneLockSetter('gens'), [createPaneLockSetter]);
  const setIsEditorPaneLocked = useMemo(() => createPaneLockSetter('editor'), [createPaneLockSetter]);
  const setIsShotsPaneLocked = useMemo(() => createPaneLockSetter('shots'), [createPaneLockSetter]);
  const setIsTasksPaneLocked = useMemo(() => createPaneLockSetter('tasks'), [createPaneLockSetter]);

  const setIsGenerationsPaneOpen = useCallback((isOpen: boolean) => {
    setIsGenerationsPaneOpenState(isOpen);
  }, []);

  const setIsEditorPaneOpen = useCallback((isOpen: boolean) => {
    setIsEditorPaneOpenState(isOpen);
  }, []);

  const setIsTasksPaneOpen = useCallback((isOpen: boolean) => {
    if (!transientPanes) {
      setIsTasksPaneOpenState(isOpen);
    }
  }, [transientPanes]);

  const resetAllPaneLocks = useCallback(() => {
    setLocks(UNLOCKED_PANES);
    setIsTasksPaneOpenState(false);
    savePaneLocks(UNLOCKED_PANES);
    if (!transientPanes) saveTasksLock(false);
  }, [savePaneLocks, saveTasksLock, transientPanes]);

  return {
    locks,
    isGenerationsPaneOpenState,
    isEditorPaneOpenState,
    isTasksPaneOpenState,
    setIsGenerationsPaneLocked,
    setIsEditorPaneLocked,
    setIsShotsPaneLocked,
    setIsTasksPaneLocked,
    setIsGenerationsPaneOpen,
    setIsEditorPaneOpen,
    setIsTasksPaneOpen,
    resetAllPaneLocks,
  };
}
