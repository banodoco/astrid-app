import { useState, useCallback, useEffect } from 'react';
import { useSettingsEventIntent } from '@/app/hooks/useSettingsModalIntents';

export function useSettingsModal() {
  const [isSettingsModalOpen, setSettingsModalOpen] = useState(false);
  const [settingsInitialTab, setSettingsInitialTab] = useState<string | undefined>(undefined);

  const handleOpenSettings = useCallback((initialTab?: string) => {
    setSettingsInitialTab(initialTab);
    setSettingsModalOpen(true);
  }, []);

  const setIsSettingsModalOpen = useCallback((open: boolean) => {
    if (!open) {
      const url = new URL(window.location.href);
      if (url.searchParams.get('settings') === 'updates') {
        url.searchParams.delete('settings');
        window.history.replaceState(window.history.state, '', url);
      }
    }
    setSettingsModalOpen(open);
  }, []);

  useSettingsEventIntent(useCallback(({ settingsTab }) => {
    handleOpenSettings(settingsTab);
  }, [handleOpenSettings]));

  useEffect(() => {
    if (new URLSearchParams(window.location.search).get('settings') === 'updates') handleOpenSettings('updates');
  }, [handleOpenSettings]);

  return {
    isSettingsModalOpen,
    setIsSettingsModalOpen,
    settingsInitialTab,
    handleOpenSettings,
  };
}
