import { createContext, useContext, type ReactNode } from 'react';
import { useAppBuildWatch } from '@/shared/lib/updates/appBuildWatch.ts';

const AppBuildContext = createContext(false);

export function usePageStale(): boolean {
  return useContext(AppBuildContext);
}

export function AppBuildProvider({ children, reload = () => window.location.reload() }: { children: ReactNode; reload?: () => void }) {
  const pageStale = useAppBuildWatch();
  return <AppBuildContext.Provider value={pageStale}>
    {children}
    {pageStale && <div role="status" className="fixed bottom-4 right-4 z-[100110] rounded-md border bg-background px-3 py-2 text-sm shadow-md">
      Editor updated · <button type="button" className="font-medium underline underline-offset-2" onClick={reload}>Reload</button>
    </div>}
  </AppBuildContext.Provider>;
}
