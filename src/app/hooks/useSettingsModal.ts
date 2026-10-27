import { useState, useCallback, useEffect } from 'react';
import { useSettingsEventIntent } from '@/app/hooks/useSettingsModalIntents';

export function useSettingsModal() {
  const [isSettingsModalOpen, setIsSettingsModalOpen] = useState(false);
  const [settingsInitialTab, setSettingsInitialTab] = useState<string | undefined>(undefined);

  const handleOpenSettings = useCallback((initialTab?: string) => {
    setSettingsInitialTab(initialTab);
    setIsSettingsModalOpen(true);
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
