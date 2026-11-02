import { useEffect, useState } from 'react';
import { Button } from '@/shared/components/ui/button.tsx';
import { RadioGroup, RadioGroupItem } from '@/shared/components/ui/radio-group.tsx';
import { SegmentedControl, SegmentedControlItem } from '@/shared/components/ui/segmented-control.tsx';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/shared/components/ui/tooltip.tsx';
import { runInstallPrompt, useInstallPromptSignals, useStandaloneStatus } from '@/shared/hooks/platformInstall/signals.ts';
import { detectInstallScenario } from '@/pages/Home/installScenario.ts';
import { LOCAL_SETUP, type WindowMode } from '@/shared/components/RuntimeConnection/copy.ts';
import { EditorCard } from '@/shared/components/RuntimeConnection/EditorCard.tsx';
import { EditorCardLayer } from '@/shared/components/RuntimeConnection/EditorCardLayer.tsx';
import { CopyFallback, useCopyAction } from '@/shared/components/RuntimeConnection/CopyInstallCommand.tsx';
import { readWelcomePhase, writeWelcomePhase } from './welcomeProgress.ts';
import { RunModeMink } from './RunModeMink/RunModeMink.tsx';

export type { WindowMode };
export type RunMode = 'hosted' | 'local';

interface Props {
  readonly onContinue: (phase: 'setup') => void;
  readonly windowMode: WindowMode;
  readonly setWindowMode: (mode: WindowMode) => void;
  readonly runMode: RunMode;
  readonly setRunMode: (mode: RunMode) => void;
}

/*
 * Each option is a grid: radio, heading and mink on the first row, the description under the heading. In a narrow
 * option the mink (1x) sits beside the heading only, so the description keeps the full width; once the option is
 * 26rem wide the mink (2x) spans both rows to the right of the text.
 */
const OPTION_LABEL = 'group grid cursor-pointer grid-cols-[auto_minmax(0,1fr)_auto] items-start gap-x-3 p-3.5 text-left @[26rem]:grid-rows-[auto_1fr]';
const OPTION_RADIO = 'col-[1] row-[1] mt-[3px] border-muted-foreground/50 data-[checked]:border-primary';
const OPTION_HEADING = 'col-[2] row-[1] flex flex-wrap items-center gap-x-2 gap-y-1';
const OPTION_MINK = 'col-[3] row-[1] group-hover:opacity-100 group-hover:saturate-100 @[26rem]:row-[1/3] @[26rem]:self-center';
const OPTION_DESCRIPTION = 'col-[2/4] row-[2] mt-1 block text-[13px] leading-5 text-muted-foreground @[26rem]:col-[2]';

export function WelcomeRunMode({ onContinue, windowMode, setWindowMode, runMode, setRunMode }: Props) {
  const { deferredPrompt, consumeDeferredPrompt } = useInstallPromptSignals();
  const standalone = useStandaloneStatus();
  const scenario = detectInstallScenario();
  const [installUnavailable, setInstallUnavailable] = useState(false);
  const canInstall = !standalone && scenario === 'chromium' && deferredPrompt !== null && !installUnavailable;
  const [opened, setOpened] = useState(false);
  const linkCopy = useCopyAction(window.location.href);

  const continueHere = () => onContinue('setup');
  const installApp = async () => {
    if (!deferredPrompt) return continueHere();
    const previousPhase = readWelcomePhase();
    writeWelcomePhase('setup');
    try {
      const { outcome } = await runInstallPrompt(deferredPrompt);
      consumeDeferredPrompt(deferredPrompt);
      if (outcome === 'accepted') setOpened(true);
      else {
        writeWelcomePhase(previousPhase);
        setInstallUnavailable(true);
      }
    } catch {
      consumeDeferredPrompt(deferredPrompt);
      writeWelcomePhase(previousPhase);
      setInstallUnavailable(true);
    }
  };

  useEffect(() => {
    if (opened && standalone) onContinue('setup');
  }, [opened, standalone, onContinue]);

  if (opened && !standalone) return <main aria-label="Astrid opened in its own window">
    <EditorCardLayer cardKey="opened">
      <EditorCard title="Astrid opened in its own window" sentence="Carry on there. You can close this tab.">
        <a href="#continue" className="text-[13px] text-muted-foreground underline underline-offset-4 hover:text-foreground" onClick={event => { event.preventDefault(); continueHere(); }}>Continue here instead</a>
      </EditorCard>
    </EditorCardLayer>
  </main>;

  const buttonLabel = runMode === 'local'
    ? 'Set up with your agent'
    : canInstall && windowMode === 'app-window'
      ? 'Install and continue'
      : standalone ? 'Continue' : 'Continue in this tab';

  return <main aria-label="How to run Astrid">
    <EditorCardLayer cardKey="choose">
      <EditorCard title="How do you want to run the app?" icon={false}>
        <div className="space-y-4">
          <RadioGroup aria-label="How to run Astrid" value={runMode} onValueChange={value => setRunMode(value as RunMode)} className="space-y-2.5">
            <div className={`@container rounded-xl border transition-colors ${runMode === 'hosted' ? 'border-primary/70 bg-primary/[0.06]' : 'border-border hover:border-foreground/25 hover:bg-muted/40'}`}>
              <label htmlFor="welcome-run-hosted" onClick={() => setRunMode('hosted')} className={OPTION_LABEL}>
                <RadioGroupItem id="welcome-run-hosted" value="hosted" aria-labelledby="welcome-title-hosted" className={OPTION_RADIO} />
                <span className={OPTION_HEADING}>
                  <span id="welcome-title-hosted" className="text-[15px] font-medium text-foreground">Use the hosted version</span>
                  <span className="rounded-full bg-muted px-2 py-px text-[11px] text-muted-foreground">Most convenient</span>
                </span>
                <RunModeMink scene="beach" active={runMode === 'hosted'} className={OPTION_MINK} />
                <span className={OPTION_DESCRIPTION}><span className="relative block pl-3.5"><span aria-hidden="true" className="absolute left-0">•</span>Your files, models & agents stay on your computer, the app accesses via Chrome</span><span className="relative block pl-3.5"><span aria-hidden="true" className="absolute left-0">•</span>The app stays up to date automatically</span></span>
              </label>
              {runMode === 'hosted' && canInstall && <div className="space-y-2 px-3.5 pb-3.5 pl-[43px]">
                <SegmentedControl value={windowMode} onValueChange={value => setWindowMode(value as WindowMode)} size="sm" aria-label="How to open Astrid">
                  <Tooltip><TooltipTrigger asChild><SegmentedControlItem value="app-window">Install as app</SegmentedControlItem></TooltipTrigger><TooltipContent>{"Its own window and a Dock or taskbar icon. Nothing to download; it's still astrid.haus."}</TooltipContent></Tooltip>
                  <Tooltip><TooltipTrigger asChild><SegmentedControlItem value="browser-tab">Stay in browser</SegmentedControlItem></TooltipTrigger><TooltipContent>Keep using it in this tab.</TooltipContent></Tooltip>
                </SegmentedControl>
              </div>}
              {runMode === 'hosted' && installUnavailable && <p className="px-3.5 pb-3.5 pl-[43px] text-[13px] leading-5 text-muted-foreground">Not installed. You can install it any time from the install icon in the address bar.</p>}
              {runMode === 'hosted' && scenario === 'unsupported' && <p className="px-3.5 pb-3.5 pl-[43px] text-[13px] text-muted-foreground">Needs Chrome or Edge to reach your computer.</p>}
            </div>
            <div className={`@container rounded-xl border transition-colors ${runMode === 'local' ? 'border-primary/70 bg-primary/[0.06]' : 'border-border hover:border-foreground/25 hover:bg-muted/40'}`}>
              <label htmlFor="welcome-run-local" onClick={() => setRunMode('local')} className={OPTION_LABEL}>
                <RadioGroupItem id="welcome-run-local" value="local" aria-labelledby="welcome-title-local" className={OPTION_RADIO} />
                <span className={OPTION_HEADING}>
                  <span id="welcome-title-local" className="text-[15px] font-medium text-foreground">Run app on your computer</span>
                  <span className="rounded-full bg-muted px-2 py-px text-[11px] text-muted-foreground">Most control</span>
                </span>
                <RunModeMink scene="desk" active={runMode === 'local'} className={OPTION_MINK} />
                <span className={OPTION_DESCRIPTION}><span className="relative block pl-3.5"><span aria-hidden="true" className="absolute left-0">•</span>Everything runs on your machine</span><span className="relative block pl-3.5"><span aria-hidden="true" className="absolute left-0">•</span>No permissions and works offline. GitHub <a className="underline underline-offset-4 hover:text-foreground" href={LOCAL_SETUP.repoUrl} target="_blank" rel="noreferrer">here</a>.</span></span>
              </label>
            </div>
          </RadioGroup>
          <Button type="button" className="h-11 w-full rounded-xl" onClick={() => {
            if (scenario === 'unsupported' && runMode === 'hosted') void linkCopy.copy();
            else if (canInstall && windowMode === 'app-window') void installApp();
            else continueHere();
          }}>{runMode === 'hosted' && scenario === 'unsupported' ? linkCopy.status === 'copied' ? 'Copied. Open it in Chrome or Edge.' : 'Copy link for Chrome or Edge' : buttonLabel}</Button>
          {runMode === 'hosted' && scenario === 'unsupported' && linkCopy.status === 'failed' && <CopyFallback text={window.location.href} label="Copy link for Chrome or Edge" />}
        </div>
      </EditorCard>
    </EditorCardLayer>
  </main>;
}
