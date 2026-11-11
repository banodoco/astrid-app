import { lazy, Suspense, useCallback, useState } from 'react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MemoryRouter } from 'react-router-dom';
import { TooltipProvider } from '@/shared/components/ui/tooltip.tsx';
import { BrowserTourEditor } from './BrowserTourEditor.tsx';
import { EditorBackdrop } from '@/shared/components/RuntimeConnection/EditorCardLayer.tsx';
import { WelcomeRunMode, type RunMode, type WindowMode } from './WelcomeRunMode.tsx';
import { WelcomeLocalSetup } from './WelcomeLocalSetup.tsx';
import { hasRememberedConnection, readWelcomePhase, readWelcomeRunMode, writeWelcomePhase, writeWelcomeRunMode, type WelcomeEntry } from './welcomeProgress.ts';
import { detectInstallScenario } from '@/pages/Home/installScenario.ts';

// Even module initialization for connection/identity stays outside the browser-only tour.
const WelcomeConnection = lazy(() => import('./WelcomeConnection.tsx'));

/**
 * The first-run welcome: tour, then (on a computer) the run-mode choice, then local setup or the connection screen, and
 * the starter-project handoff behind it. Every screen is an editor card; the connection screen carries the install and
 * permission help. A phone or tablet on the hosted site has no choice and nothing to set up: it goes from the tour to the
 * connection screen, whose phone card says to open Astrid on a computer and sends the link there.
 */
export function WelcomeFlow({ entry, localBuild = false }: { entry: WelcomeEntry; localBuild?: boolean }) {
  const [onlyPhoneCard] = useState(() => !localBuild && detectInstallScenario() === 'mobile');
  const [queryClient] = useState(() => new QueryClient({ defaultOptions: { queries: { retry: false } } }));
  const [phase, setPhase] = useState<WelcomeEntry>(() => {
    const savedPhase = readWelcomePhase(localBuild);
    // A stale choose/local record (another device, an older visit) has no screen a phone can use.
    if (onlyPhoneCard && (entry === 'choose' || entry === 'local' || entry === 'connection') && savedPhase !== 'complete') {
      writeWelcomePhase('connection');
      return 'connection';
    }
    // An installer handoff must not change a fully local setup into the hosted route.
    if (entry === 'connection' && savedPhase !== 'complete' && (savedPhase === 'local' || readWelcomeRunMode() === 'local')) return 'local';
    if (entry !== 'editor' && savedPhase !== 'complete') writeWelcomePhase(entry);
    return entry;
  });
  const [windowMode, setWindowMode] = useState<WindowMode>('app-window');
  const [runMode, setRunModeState] = useState<RunMode>(() => readWelcomeRunMode() ?? (phase === 'local' ? 'local' : 'hosted'));
  const setRunMode = useCallback((mode: RunMode) => { writeWelcomeRunMode(mode); setRunModeState(mode); }, []);
  // Back to the tour shows its last card, never its welcome.
  const [tourAtEnd, setTourAtEnd] = useState(false);
  const enter = useCallback((next: 'tour' | 'choose' | 'connection' | 'local') => {
    writeWelcomePhase(next);
    setPhase(next);
  }, []);
  const backToTour = useCallback(() => { setTourAtEnd(true); enter('tour'); }, [enter]);
  // A local build has no run-mode choice (it is local); a phone has neither choice nor setup.
  const finishTour = useCallback(() => enter(onlyPhoneCard ? 'connection' : localBuild ? 'local' : 'choose'), [enter, localBuild, onlyPhoneCard]);
  // Back goes to the screen this one came from.
  const backFromLocal = localBuild ? backToTour : () => enter('choose');
  const backFromConnection = onlyPhoneCard ? backToTour : localBuild || runMode === 'local' ? () => enter('local') : () => enter('choose');
  return <QueryClientProvider client={queryClient}><TooltipProvider><MemoryRouter>
    {phase === 'tour' && <BrowserTourEditor onFinish={finishTour} atEnd={tourAtEnd} />}
    {phase === 'choose' && <WelcomeRunMode onContinue={enter} onBack={backToTour} windowMode={windowMode} setWindowMode={setWindowMode} runMode={runMode} setRunMode={setRunMode} />}
    {phase === 'local' && <WelcomeLocalSetup onBack={backFromLocal} initiallySetUp={hasRememberedConnection()} onContinue={() => enter('connection')} />}
    {phase === 'connection' && <Suspense fallback={<><EditorBackdrop /><p role="status" className="sr-only">Connecting to Astrid…</p></>}><WelcomeConnection onBack={backFromConnection} /></Suspense>}
  </MemoryRouter></TooltipProvider></QueryClientProvider>;
}
